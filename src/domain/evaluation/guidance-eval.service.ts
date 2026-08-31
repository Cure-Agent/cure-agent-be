/**
 * 참고안 구조화 측정 (docs/specs/33 측정 계획 — 배포 전 채택 게이트).
 *
 * **기계 지표만으로 채택을 정하지 않는다.** 「근거·프로필 밖 임상 항목 창작 0건」과
 * 「프로필 오독 0건」은 사람이 봐야 판정되므로, 이 서비스는 통과율·폴백률·지연을 집계하고
 * 판정 대상 항목 전문을 리포트에 실어 육안 전수 검토를 가능하게 한다. 케이스를 ~30으로
 * 잡은 이유가 그것이다 — LLM 심판 없이 전수를 볼 수 있는 규모.
 *
 * 2차 사이클부터 문항–프로필은 **커레이션**이다(guidance-eval.cases.ts). 1차의 순환 배정은
 * 표본을 「주제 부정합 → 해당없음」에 몰아 가치 제안 자체를 재지 못했다.
 *
 * DB 쓰기는 없다. 영속화는 conversation-stream의 몫이고 여기는 오프라인 도구다.
 */
import { Inject, Injectable } from '@nestjs/common';
import { GUIDANCE_PROMPT_VERSION } from '../../infrastructure/llm/guidance/guidance-prompt';
import {
  GUIDANCE_STRUCTURER,
  GuidanceStructurer,
} from '../../infrastructure/llm/guidance/guidance-structurer.port';
import { structureWithTimeout } from '../../infrastructure/llm/guidance/structure-runner';
import { LlmGateway } from '../../infrastructure/llm/llm-gateway';
import { RERANKER, Reranker } from '../../infrastructure/retrieval/reranker.port';
import { RetrievalService, RetrievedEvidence } from '../../infrastructure/retrieval/retrieval.service';
import { GuidanceConsiderationJson } from '../clinical-guidance/persistence/clinical-guidance.schema';
import { validateStructuredConsiderations } from '../clinical-guidance/service/guidance-consideration.validator';
import { presentGuidanceProfileFields } from '../clinical-guidance/service/guidance-profile-fields';
import { composeGuidanceQuestion } from '../clinical-guidance/service/guidance-question';
import { AnswerCitationResponseDto } from '../conversation/dto/response/answer-citation.response.dto';
import { EvalSetItem } from './evalset.types';
import {
  GUIDANCE_EVAL_CASES,
  GuidanceEvalCaseFixture,
  GuidanceEvalExpectation,
} from './guidance-eval.cases';
import { generateRealPathAnswer } from './real-path-generator';

const QUOTE_LIMIT = 120;

export type GuidanceEvalOutcome = 'structured' | 'fallback' | 'skipped';

export interface GuidanceEvalCase {
  itemId: string;
  caseLabel: string;
  expectation: GuidanceEvalExpectation;
  question: string;
  answer: string;
  /** 답변이 실제 인용한 마커 — 근거 다리의 모집단 */
  citedMarkers: number[];
  /** 값이 채워진 프로필 필드명 — 환자 다리의 모집단 */
  profileFields: string[];
  /** 구조화기가 낸 항목 수 (검증 전) */
  producedCount: number;
  /** 검증을 통과해 참고안에 실릴 항목 — 육안 판정의 대상이다 */
  accepted: GuidanceConsiderationJson[];
  outcome: GuidanceEvalOutcome;
  /** 구조화 호출 소요(초). 미호출이면 null */
  durationSec: number | null;
}

export interface GuidanceEvalFailure {
  itemId: string;
  caseLabel: string;
  reason: string;
}

export interface GuidanceEvalReport {
  promptVersion: string;
  structurerModel: string;
  caseCount: number;
  outcomes: Record<GuidanceEvalOutcome, number>;
  /**
   * 폴백률 (docs/specs/33 2차 분모 규약) — 분모에서 `missing`을 뺀다.
   * 전결측은 환자 다리를 세울 수 없어 **폴백이 정답**이므로, 분모에 넣으면 설계상 반드시
   * 폴백하는 케이스를 폴백률로 재는 잘못된 계량이 된다(1차 실패의 절반이 이것이었다).
   */
  fallbackRate: { fallback: number; denominator: number };
  /**
   * 전결측인데 structured로 나온 케이스 — 두 다리 강제가 깨졌다는 뜻이라 **즉시 실패**다.
   * 분모에서 뺀 대가로 반드시 따로 감시해야 하는 축이다.
   */
  missingViolations: string[];
  /** 두 다리 검증 통과율의 분자·분모 — 구조화기가 낸 항목 중 검증을 통과한 비율 */
  legValidation: { produced: number; accepted: number };
  latency: { p50: number; p90: number; max: number } | null;
  cases: GuidanceEvalCase[];
  failures: GuidanceEvalFailure[];
}

@Injectable()
export class GuidanceEvalService {
  constructor(
    private readonly retrieval: RetrievalService,
    @Inject(RERANKER) private readonly reranker: Reranker,
    private readonly llmGateway: LlmGateway,
    @Inject(GUIDANCE_STRUCTURER) private readonly structurer: GuidanceStructurer,
  ) {}

  async evaluate(
    items: EvalSetItem[],
    options: { limit?: number; fixtures?: readonly GuidanceEvalCaseFixture[] } = {},
  ): Promise<GuidanceEvalReport> {
    const questionById = new Map(items.map((item) => [item.id, item.question]));
    const fixtures = (options.fixtures ?? GUIDANCE_EVAL_CASES).slice(
      0,
      options.limit ?? Number.MAX_SAFE_INTEGER,
    );

    const cases: GuidanceEvalCase[] = [];
    const failures: GuidanceEvalFailure[] = [];
    const outcomes: Record<GuidanceEvalOutcome, number> = {
      structured: 0,
      fallback: 0,
      skipped: 0,
    };
    const durations: number[] = [];
    let produced = 0;
    let accepted = 0;

    for (const fixture of fixtures) {
      const question = questionById.get(fixture.itemId);
      if (question === undefined) {
        // 커레이션이 평가셋과 어긋난 것은 조용히 넘길 결함이 아니다 — 케이스 수가 줄면
        // 폴백률 분모가 함께 줄어 지표가 오염된다
        failures.push({
          itemId: fixture.itemId,
          caseLabel: fixture.profile.caseLabel,
          reason: '평가셋에 없는 문항 id — 커레이션과 평가셋이 어긋났다',
        });
        continue;
      }

      try {
        const evaluated = await this.evaluateCase(fixture, question);
        cases.push(evaluated);
        outcomes[evaluated.outcome] += 1;
        produced += evaluated.producedCount;
        accepted += evaluated.accepted.length;
        if (evaluated.durationSec !== null) durations.push(evaluated.durationSec);
      } catch (error) {
        // 한 문항의 생성 실패로 비싼 실행을 통째로 버리지 않는다 (docs/specs/30 계보)
        failures.push({
          itemId: fixture.itemId,
          caseLabel: fixture.profile.caseLabel,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const rated = cases.filter((item) => item.expectation !== 'missing');
    return {
      promptVersion: GUIDANCE_PROMPT_VERSION,
      structurerModel: this.structurer.model,
      caseCount: cases.length,
      outcomes,
      fallbackRate: {
        fallback: rated.filter((item) => item.outcome === 'fallback').length,
        denominator: rated.length,
      },
      missingViolations: cases
        .filter((item) => item.expectation === 'missing' && item.outcome === 'structured')
        .map((item) => `${item.itemId}·${item.caseLabel}`),
      legValidation: { produced, accepted },
      latency: percentiles(durations),
      cases,
      failures,
    };
  }

  private async evaluateCase(
    fixture: GuidanceEvalCaseFixture,
    question: string,
  ): Promise<GuidanceEvalCase> {
    const { profile } = fixture;
    const { answer, top } = await generateRealPathAnswer(
      { retrieval: this.retrieval, reranker: this.reranker, llmGateway: this.llmGateway },
      {
        retrievalQuestion: question,
        promptQuestion: composeGuidanceQuestion(profile, question),
      },
    );

    const usedMarkers = new Set(
      [...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])),
    );
    const cited = top
      .map((row, index) => ({ row, marker: index + 1 }))
      .filter(({ marker }) => usedMarkers.has(marker));
    const profileFields = presentGuidanceProfileFields(profile);

    const base = {
      itemId: fixture.itemId,
      caseLabel: profile.caseLabel,
      expectation: fixture.expectation,
      question,
      answer,
      citedMarkers: cited.map(({ marker }) => marker),
      profileFields: profileFields.map((field) => field.field),
    };

    if (cited.length === 0) {
      return { ...base, producedCount: 0, accepted: [], outcome: 'skipped', durationSec: null };
    }

    const startedAt = Date.now();
    const structured = await structureWithTimeout(this.structurer, {
      answerText: answer,
      evidence: cited.map(({ row, marker }) => ({
        marker,
        content: row.chunk.content,
        guidelineTitle: row.guideline.title,
        sectionPath: row.section.path,
      })),
      profileFields,
      // 평가셋이 한국어라 기준선도 한국어 프롬프트로 잰다 (docs/specs/44 — 언어를 섞으면
      // 폴백률 실측이 두 프롬프트를 한 수치로 뭉갠다)
      lang: 'ko',
    });
    const durationSec = (Date.now() - startedAt) / 1000;

    if (!structured) {
      return { ...base, producedCount: 0, accepted: [], outcome: 'fallback', durationSec };
    }

    const validated = validateStructuredConsiderations({
      structured,
      citations: cited.map(({ row, marker }) => toCitation(row, marker)),
      profileFields,
    });

    return {
      ...base,
      producedCount: structured.considerations.length,
      accepted: validated,
      outcome: validated.length > 0 ? 'structured' : 'fallback',
      durationSec,
    };
  }
}

function toCitation(row: RetrievedEvidence, marker: number): AnswerCitationResponseDto {
  return {
    marker,
    evidenceId: row.chunk.id,
    guidelineTitle: row.guideline.title,
    guidelineVersion: row.version.version,
    sectionPath: row.section.path,
    quote:
      row.chunk.content.length <= QUOTE_LIMIT
        ? row.chunk.content
        : `${row.chunk.content.slice(0, QUOTE_LIMIT)}…`,
    sourceUrl: row.version.sourceUrl ?? '',
  };
}

function percentiles(values: number[]): { p50: number; p90: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] };
}
