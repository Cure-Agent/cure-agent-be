/**
 * groundedness 평가 (docs/specs/30).
 *
 * **실경로를 재현한다** — 검색 K=30 → 리랭크 → top-5 → qa-v3 프롬프트 → LlmGateway.
 * 평가만의 지름길을 두면 측정 대상이 프로덕션 답변이 아니게 된다.
 * DB 쓰기는 없다: 영속화는 conversation-stream의 몫이고 여기는 오프라인 도구다.
 */
import { Inject, Injectable } from '@nestjs/common';
import { LlmGateway } from '../../infrastructure/llm/llm-gateway';
import { PROMPT_VERSION } from '../../infrastructure/llm/prompt-builder';
import { RERANKER, Reranker } from '../../infrastructure/retrieval/reranker.port';
import {
  RETRIEVAL_TOP_K,
  RetrievalService,
  RetrievedEvidence,
} from '../../infrastructure/retrieval/retrieval.service';
import { EvalSetItem } from './evalset.types';
import {
  GROUNDEDNESS_JUDGE,
  GroundednessJudge,
  GroundednessVerdict,
  JudgedEvidence,
} from './groundedness-judge.port';

/** qa-v3 규칙 6 위반 — 굵게·제목·목록 기호 (화면이 평문 렌더링) */
const MARKDOWN_PATTERN = /(\*\*|^#{1,6}\s|^\s*[-*]\s)/m;
/** 규칙 2의 인용 마커 */
const MARKER_PATTERN = /\[\d\]/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 정규식으로 판정 가능한 qa-v3 규칙 — 심판을 부르지 않고 잡는다 */
export interface MechanicalChecks {
  /** 규칙 6 위반 (화면이 평문 렌더링이라 기호가 그대로 노출된다) */
  markdownViolations: number;
  /** 마커가 하나도 없는 답변 — 규칙 2에 따라 인용이 하나도 기록되지 않는다 */
  noMarkerAnswers: number;
}

/** partial·ungrounded 문항 — 리포트가 나열해 다음 프롬프트 개선의 표적이 된다 */
export interface FlaggedAnswer {
  itemId: string;
  question: string;
  verdict: GroundednessVerdict;
  miscited: number;
  unsupported: number;
  unsupportedExamples: string[];
  /** miscited 주장 원문 (docs/specs/32) — 다음 사이클 표적의 드릴다운 */
  miscitedExamples: string[];
}

/**
 * 과억제 감시 (docs/specs/32) — 프롬프트를 조이는 개선이 답변을 앙상하게 만드는
 * 부작용을 잡는다. 값은 반올림해 저장한다(평균 주장 수 소수 1자리·답변 길이 정수) —
 * 리포트가 그대로 실어 객체와 마크다운이 같은 값을 가리킨다. answerable 0이면 전부 0.
 */
export interface SuppressionGuard {
  /** 문항당 평균 주장 수 — 기준선 3.5(645/185) 대비 25% 이상 급감이면 과억제 신호 */
  avgClaimsPerAnswer: number;
  /** 평균 답변 길이 (문자) */
  avgAnswerLengthChars: number;
  /** 근거 부족 고지(insufficiencyDisclosed) 답변 수 */
  insufficiencyDisclosedCount: number;
}

/** 생성 또는 채점이 실패한 문항 — 조용히 빠지면 지표가 낙관 오염된다 (docs/specs/27 계보) */
export interface GroundednessFailure {
  itemId: string;
  stage: 'generation' | 'judge';
  reason: string;
}

export interface GroundednessReport {
  /** 이 측정이 잰 생성 계약 — qa-v3 등 (prompt-builder의 PROMPT_VERSION) */
  promptVersion: string;
  judgeModel: string;
  answerableCount: number;
  verdicts: Record<GroundednessVerdict, number>;
  claims: {
    total: number;
    supported: number;
    miscited: number;
    unsupported: number;
  };
  mechanical: MechanicalChecks;
  suppressionGuard: SuppressionGuard;
  flagged: FlaggedAnswer[];
  failures: GroundednessFailure[];
}

@Injectable()
export class GroundednessEvalService {
  constructor(
    private readonly retrieval: RetrievalService,
    @Inject(RERANKER) private readonly reranker: Reranker,
    @Inject(GROUNDEDNESS_JUDGE) private readonly judge: GroundednessJudge,
    private readonly llmGateway: LlmGateway,
  ) {}

  /**
   * answerable 문항만 생성·채점해 집계한다 — abstain은 기권이 정답이라 채점할 답변이 없다.
   * 실패 문항은 예외로 던지지 않고 리포트에 모은다: 한 문항의 LLM 실패로 나머지 측정을
   * 버리면 비싼 실행이 통째로 낭비되고, 조용히 빼면 지표가 낙관 오염된다(§27 계보).
   * 비영 종료 판단은 호출측(CLI)의 몫이다.
   */
  async evaluate(items: EvalSetItem[]): Promise<GroundednessReport> {
    const answerable = items.filter((item) => item.kind === 'answerable');
    const verdicts: Record<GroundednessVerdict, number> = {
      grounded: 0,
      partial: 0,
      ungrounded: 0,
    };
    const claims = { total: 0, supported: 0, miscited: 0, unsupported: 0 };
    const mechanical: MechanicalChecks = { markdownViolations: 0, noMarkerAnswers: 0 };
    const flagged: FlaggedAnswer[] = [];
    const failures: GroundednessFailure[] = [];
    // 과억제 감시의 두 분모는 다르다 — 심판만 실패한 문항은 답변이 생성됐으므로 길이
    // 통계에는 들어가고 주장 수 통계에는 들어갈 수 없다 (docs/specs/32 기준 7)
    let generatedCount = 0;
    let answerLengthSum = 0;
    let judgedCount = 0;
    let insufficiencyDisclosedCount = 0;

    for (const item of answerable) {
      let answer: string;
      let evidence: JudgedEvidence[];
      try {
        const generated = await this.generate(item.question);
        answer = generated.answer;
        evidence = generated.evidence;
      } catch (error) {
        failures.push({ itemId: item.id, stage: 'generation', reason: messageOf(error) });
        continue;
      }

      generatedCount += 1;
      answerLengthSum += answer.length;

      if (MARKDOWN_PATTERN.test(answer)) mechanical.markdownViolations += 1;
      if (!MARKER_PATTERN.test(answer)) mechanical.noMarkerAnswers += 1;

      try {
        const judgement = await this.judge.judge({ question: item.question, evidence, answer });
        judgedCount += 1;
        if (judgement.insufficiencyDisclosed) insufficiencyDisclosedCount += 1;
        verdicts[judgement.verdict] += 1;
        claims.total += judgement.claims;
        claims.supported += judgement.supported;
        claims.miscited += judgement.miscited;
        claims.unsupported += judgement.unsupported;
        if (judgement.verdict !== 'grounded') {
          flagged.push({
            itemId: item.id,
            question: item.question,
            verdict: judgement.verdict,
            miscited: judgement.miscited,
            unsupported: judgement.unsupported,
            unsupportedExamples: judgement.unsupportedExamples,
            miscitedExamples: judgement.miscitedExamples,
          });
        }
      } catch (error) {
        failures.push({ itemId: item.id, stage: 'judge', reason: messageOf(error) });
      }
    }

    return {
      promptVersion: PROMPT_VERSION,
      judgeModel: this.judge.model,
      answerableCount: answerable.length,
      verdicts,
      claims,
      mechanical,
      suppressionGuard: {
        avgClaimsPerAnswer:
          judgedCount === 0 ? 0 : Math.round((claims.total / judgedCount) * 10) / 10,
        avgAnswerLengthChars:
          generatedCount === 0 ? 0 : Math.round(answerLengthSum / generatedCount),
        insufficiencyDisclosedCount,
      },
      flagged,
      failures,
    };
  }

  /**
   * 실경로 재현 — 검색 K=30 → 리랭크 → top-5 → LlmGateway.
   * 리랭크 실패는 코사인 순위 폴백이다(docs/specs/29 기준 6과 같은 규약) — 평가가
   * 리랭커 가용성에 묶이면 생성 축 측정이 검색 축 장애로 중단된다.
   */
  private async generate(
    question: string,
  ): Promise<{ answer: string; evidence: JudgedEvidence[] }> {
    const results = await this.retrieval.search(
      question,
      undefined,
      this.retrieval.rerankCandidates,
    );
    let top = results.slice(0, RETRIEVAL_TOP_K);
    try {
      const reranked = await this.reranker.rerank(
        question,
        results.map((row) => ({
          chunkId: row.chunk.id,
          content: row.chunk.content,
          guidelineTitle: row.guideline.title,
        })),
      );
      const byChunkId = new Map(results.map((row) => [row.chunk.id, row]));
      const ordered = reranked.order
        .map((chunkId) => byChunkId.get(chunkId))
        .filter((row): row is RetrievedEvidence => row !== undefined)
        .slice(0, RETRIEVAL_TOP_K);
      if (ordered.length > 0) top = ordered;
    } catch {
      // 코사인 순위 유지
    }

    const evidence: JudgedEvidence[] = top.map((row, index) => ({
      marker: index + 1,
      content: row.chunk.content,
      guidelineTitle: row.guideline.title,
    }));

    let answer = '';
    await this.llmGateway.stream(
      {
        question,
        evidence: top.map((row, index) => ({
          marker: index + 1,
          content: row.chunk.content,
          guidelineTitle: row.guideline.title,
          sectionPath: row.section.path,
        })),
      },
      (delta) => {
        answer += delta;
      },
    );

    return { answer, evidence };
  }
}
