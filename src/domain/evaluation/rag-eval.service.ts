/**
 * RAG 검색 기준선 측정 (docs/specs/27 수용 기준 5).
 *
 * Recall@5·MRR@5는 운영 지표이고 **Recall@30은 진단용**이다 — 후보군에 정답이 있는데 순서가
 * 나쁜 것(리랭커)과 애초에 못 찾는 것(하이브리드·모델 교체)을 가르는 축이기 때문이다.
 */
import { Inject, Injectable } from '@nestjs/common';
import { LlmGateway } from '../../infrastructure/llm/llm-gateway';
import {
  LlmAnswerVerdict,
  LlmEvidenceContext,
} from '../../infrastructure/llm/llm-provider.port';
import { PROMPT_VERSION } from '../../infrastructure/llm/prompt-builder';
import {
  HybridEvidence,
  RETRIEVAL_TOP_K,
  RetrievalService,
} from '../../infrastructure/retrieval/retrieval.service';
import { RERANKER, Reranker } from '../../infrastructure/retrieval/reranker.port';
import {
  GENERATION_RETRY_DELAYS_MS,
  RERANK_RETRY_DELAYS_MS,
  withRateLimitRetry,
} from './eval-retry';
import { EvalKind, EvalSetItem } from './evalset.types';
import { LabelResolver } from './label-resolver';

/** 진단용 상한 — 이 K까지 열어도 못 찾으면 순서 문제가 아니다 */
export const EVAL_DIAGNOSTIC_K = 30;

/**
 * 컷 스윕의 상한. 리랭크 점수가 0~10이므로 이 구간이 컷의 정의역 전체다 —
 * 컷 0은 「점수 게이트 없음」이고(`0 < 0`은 거짓이다) 컷 10은 최강이다.
 */
export const CUT_SWEEP_MAX = 10;

/** kind별 거리 분포 — 거리 컷을 데이터로 정하기 위한 원자료 */
export interface DistanceDistribution {
  kind: EvalKind;
  p10: number;
  p50: number;
  p90: number;
  count: number;
}

/** 기대 근거를 찾지 못한 문항 — 리포트가 이걸 나열해야 다음 개입을 고를 수 있다 */
export interface EvalFailure {
  itemId: string;
  question: string;
  /** 벡터 arm에서 정답이 나타난 순위(1-based). 30까지 열어도 없으면 null */
  foundAtRank: number | null;
  /**
   * 키워드 arm에서 정답이 나타난 순위(1-based). 없으면 null (docs/specs/31).
   * 두 arm을 나란히 놓아야 「어느 arm이 이 문항을 구제했는가/둘 다 놓쳤는가」가 읽힌다.
   */
  keywordFoundAtRank: number | null;
}

/** kind별 리랭크 점수 분포 — 점수 컷을 데이터로 정하기 위한 원자료 (issue #232) */
export interface RelevanceDistribution {
  kind: EvalKind;
  /** 점수(0~10) → 문항 수. 컷을 어디에 두면 무엇이 갈리는지 이 표 하나로 답한다 */
  histogram: Record<number, number>;
}

/**
 * 답해야 하는데 기권된 문항 (issue #236) — 기권 실패 목록의 대칭축이다.
 * 컷을 낮출지 판단하려면 「근거가 실제로 애매한 문항인가, 리랭커가 짜게 준 정상 문항인가」를
 * 봐야 하고, 어느 게이트가 잘랐는지가 나와야 §28(거리)·§29(점수) 중 어디를 손댈지 갈린다.
 */
export interface OverAbstainFailure {
  itemId: string;
  question: string;
  top1Distance: number;
  /** 거리 게이트에서 잘려 리랭크를 타지 않았으면 null */
  top1Relevance: number | null;
  gate: 'distance' | 'score' | 'both';
  /** 기대 근거가 top-30에 나타난 순위 — 기권이 검색 실패 때문인지 게이트 때문인지 가른다 */
  foundAtRank: number | null;
}

export interface AbstainFailure {
  itemId: string;
  question: string;
  top1Distance: number;
  top1Relevance: number;
  top1Guideline: string;
}

/**
 * 생성 게이트(§40 게이트 ④) 판정 상태.
 *
 * `no_verdict`와 `failed`를 가르는 이유: 전자는 **정상 상태**(fail-open — 킬스위치 off·anthropic
 * 폴백)이고 프로덕션이 실제로 답하므로 답변으로 세야 하지만, 후자는 측정 실패라 답변으로 세면
 * 지표가 낙관 오염된다(§27 계보).
 */
export type GenerationGateStatus =
  /** 판정 방출, insufficientEvidence=false — 답변 */
  | 'answerable'
  /** 판정 방출, insufficientEvidence=true — 게이트 발화 */
  | 'insufficient'
  /** 프로바이더가 판정을 내지 않았다 — fail-open이 유효한 상태다 (포트가 미방출을 허용한다) */
  | 'no_verdict'
  /** 근거 0건 — 생성을 부를 수 없다. 이 문항은 컷과 무관하게 거리 게이트에 잘린다 */
  | 'not_generated'
  /** 생성 호출 실패 — 답변으로도 기권으로도 세지 않는다 */
  | 'failed';

/** 프로덕션 `rag_generation_gate_total`과 같은 판정 — 빈 축의 처방은 이 분포가 드러난 뒤다 (§40) */
export type GenerationGateCause = 'model_verdict' | 'empty_aspects';

/** 문항별 생성 판정 — 컷 스윕의 원자료이자 과잉 기권 드릴다운의 입구 */
export interface GenerationVerdictRecord {
  itemId: string;
  kind: EvalKind;
  question: string;
  status: GenerationGateStatus;
  /** 발화 문항만 채워진다. 그 외는 null */
  cause: GenerationGateCause | null;
  missingAspects: string[];
  /** 리랭크 top-1 점수 — 컷 스윕의 라우팅 축. 리랭크를 타지 않았으면 null */
  top1Relevance: number | null;
  /** 거리 게이트(§28)에 잘렸는가 — 컷과 무관한 고정 축이다 */
  distanceAbstained: boolean;
  /** `status='failed'`일 때의 사유. 그 외는 null */
  failureReason: string | null;
}

/** 한 컷에서 kind 하나가 어느 게이트로 갈리는가 — 네 값의 합이 그 kind의 문항 수다 */
export interface GateBreakdown {
  /** 거리 게이트 || 점수 < 컷 */
  retrievalGate: number;
  /** 검색을 통과한 뒤 생성 게이트가 발화 */
  generationGate: number;
  /** 두 게이트를 다 통과 — verdict 미방출(fail-open) 포함 */
  answered: number;
  /** 검색은 통과했으나 생성이 실패해 판정이 없다 — 답변으로 세면 낙관 오염이다 */
  generationFailed: number;
}

/**
 * 컷 c에서의 문항 배분. `cutoff`는 0~10 정수 오름차순으로 전 구간을 싣는다.
 *
 * 한 번의 실행으로 전 구간을 재구성할 수 있는 이유: **컷은 라우팅에만 쓰이고 생성 입력을 바꾸지
 * 않는다.** 리랭크 top-5는 컷과 무관하게 정해지므로, 컷 c를 통과한 문항이 받는 근거는 이 평가가
 * 보낸 것과 같다 — 재구성이 컷 c의 운영 동작과 정확히 일치한다.
 */
export interface CutSweepRow {
  cutoff: number;
  answerable: GateBreakdown;
  abstain: GateBreakdown;
}

export interface RagEvalOptions {
  /**
   * 생성 게이트를 측정할지 (기본 **true**).
   * 끄면 문항당 LLM 호출이 사라지는 대신 컷 스윕에 생성 축이 비고, 리포트가 그 사실을 명시한다.
   */
  generation?: boolean;
}

export interface RagEvalReport {
  /** 검색 정책 — 이 값이 다르면 지표를 나란히 비교하지 않는다 */
  retrievalPolicyVersion: string;
  corpusChunkCount: number;
  answerableCount: number;
  abstainCount: number;
  recallAt5: number;
  mrrAt5: number;
  recallAt30: number;
  /**
   * 키워드 arm 단독 Recall@K (docs/specs/31) — 벡터 원 지표와 나란히 놓는 대조 축이다.
   * 이 값이 벡터 Recall@30을 넘는 구간이 「임베딩이 놓치고 자구가 잡는」 문항이다.
   */
  keywordRecallAtK: number;
  /**
   * 합집합 후보 커버리지 (docs/specs/31) — 기대 근거가 융합 후보(무절단)에 있는 비율.
   * **리랭커가 도달할 수 있는 상한**이라 리랭크 지표를 읽는 기준선이 된다.
   */
  unionCoverage: number;
  /** 기권 판정에 쓰인 거리 임계값 (docs/specs/28) */
  distanceCutoff: number;
  /** 리랭크 적용 지표 (docs/specs/29 기준 10) — 원 순위 지표(recallAt5 등)는 컷·리랭크 미적용 유지 */
  rerankedRecallAt5: number;
  rerankedMrrAt5: number;
  /** 점수 게이트 포함 기권 지표 — 거리 게이트(§28)와 합산된 최종 판정 기준 */
  rerankedAbstainRecall: number;
  rerankedOverAbstainRate: number;
  rerankScoreCutoff: number;
  /** 기권해야 하는 문항 중 top-1 > 컷으로 실제 기권되는 비율 (docs/specs/28 기준 8) */
  abstainRecall: number;
  /** 답해야 하는 문항 중 top-1 > 컷으로 억울하게 기권되는 비율 (docs/specs/28 기준 8) */
  overAbstainRate: number;
  distances: DistanceDistribution[];
  relevances: RelevanceDistribution[];
  failures: EvalFailure[];
  /** 기권해야 하는데 답해버린 문항 — 게이트 조정·라벨 검증의 유일한 입구 */
  abstainFailures: AbstainFailure[];
  /** 답해야 하는데 기권된 문항 — 컷 상향의 대가를 문항 단위로 본다 */
  overAbstainFailures: OverAbstainFailure[];
  /**
   * 판정을 낸 생성 계약 (prompt-builder의 PROMPT_VERSION) — 프롬프트가 바뀌면 verdict도
   * 바뀌므로, 정책 버전이 검색 지표에 하는 역할을 이 값이 생성 지표에 한다. 미측정이면 빈 문자열.
   */
  promptVersion: string;
  /** 생성을 실제로 호출했는가 — false면 아래 두 필드의 생성 축은 「측정하지 않음」이다 */
  generationMeasured: boolean;
  /** 문항별 생성 판정 — 발화 문항 드릴다운과 컷 스윕의 원자료 */
  generationVerdicts: GenerationVerdictRecord[];
  /** 컷 0~10 스윕 — 「컷을 낮추면 생성 게이트가 얼마나 받아내는가」에 답하는 표 */
  cutSweep: CutSweepRow[];
}

/**
 * nearest-rank 백분위. 표본이 적어도(문항 수십 개) 정의가 흔들리지 않는 쪽을 고른다 —
 * 보간법은 표본 3개에서 값이 실제 관측치가 아닌 지점을 가리켜 「이 거리에서 갈린다」를 흐린다.
 */
function percentile(sortedAscending: number[], fraction: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedAscending.length);
  return sortedAscending[Math.min(Math.max(rank, 1), sortedAscending.length) - 1];
}

/**
 * 점수 히스토그램 — 백분위 대신 전수 도수를 싣는다 (issue #232).
 * 컷은 0~10 정수 위에서 정해지므로 「9로 올리면 abstain 몇 건이 걸리고 answerable 몇 건을
 * 잃는가」에 답하려면 각 점수의 문항 수가 그대로 필요하다.
 */
function relevanceHistogramOf(kind: EvalKind, scores: number[]): RelevanceDistribution {
  const histogram: Record<number, number> = {};
  for (const score of scores) {
    const bucket = Math.max(0, Math.min(10, Math.round(score)));
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }
  return { kind, histogram };
}

/**
 * 융합 결과에서 한 arm의 순위 순서를 복원한다 (docs/specs/31).
 * 그 arm에 없는 행(순위 null)은 빠진다 — 벡터 원 지표가 융합 순서에 오염되지 않게 하는 지점이다.
 */
function orderByArm(
  rows: HybridEvidence[],
  arm: 'vectorRank' | 'keywordRank',
): HybridEvidence[] {
  return rows
    .filter((row) => row[arm] !== null)
    .sort((a, b) => (a[arm] as number) - (b[arm] as number));
}

/** 기대 근거가 나타난 순위(1-based). 없으면 null */
function rankIn(rows: HybridEvidence[], expected: Set<string>): number | null {
  const zeroBased = rows.findIndex((row) => expected.has(row.chunk.id));
  return zeroBased === -1 ? null : zeroBased + 1;
}

function distributionOf(kind: EvalKind, distances: number[]): DistanceDistribution {
  const sorted = [...distances].sort((a, b) => a - b);
  return {
    kind,
    p10: percentile(sorted, 0.1),
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    count: sorted.length,
  };
}

/**
 * 문항 하나의 라우팅 원자료 — 컷 스윕은 이 배열 위에서 컷마다 재계산된다.
 * 생성을 측정하지 않아도 검색 축은 채워지므로 스윕 자체는 언제나 성립한다(생성 축만 빈다).
 */
interface ItemRouting {
  item: EvalSetItem;
  /** 거리 게이트(§28) 판정 — 컷과 무관한 고정 축이다 */
  distanceAbstained: boolean;
  /** 리랭크 top-1 점수. 검색 0건이면 null */
  top1Relevance: number | null;
  /** 생성을 측정한 경우에만 채워진다 */
  verdict: GenerationVerdictRecord | null;
  /**
   * 게이트 판정 **이전** 단계의 측정 실패 — 리랭크 재시도 소진 등 (이슈 #352).
   *
   * 게이트 갈래와 따로 두는 이유: 점수를 못 얻은 문항을 `top1Relevance: null`로 흘리면
   * 컷 스윕에서 검색 게이트로 세어져 **「게이트가 잘랐다」로 위장**된다. 측정하지 못한 것과
   * 게이트가 자른 것은 다른 사실이므로 다르게 세야 한다.
   */
  failureReason: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 리랭크 시도의 결과 (이슈 #352).
 *
 * 던지지 않고 값으로 돌려주는 이유: 리랭크는 문항마다 실패할 수 있는데 예외로 올리면
 * 호출부가 `evaluate()` 전체를 잃거나 매 호출을 try/catch로 감싸야 한다. 실패가 정상
 * 경로의 일부이므로 타입에 싣는다.
 */
type RerankOutcome =
  | { ok: true; orderedChunkIds: string[]; top1Relevance: number }
  | { ok: false; reason: string };

/**
 * 컷 c에서 문항 하나가 어느 갈래로 가는가 — **런타임 게이트와 같은 판정**이다.
 *
 * 점수 비교는 반올림하지 않고 원 점수로 한다: `conversation-stream`이
 * `top1Relevance < rerankScoreCutoff`를 원 값으로 재므로, 버킷팅하면 재구성이 운영과 갈린다
 * (히스토그램만 반올림하는 이유는 도수를 세기 위한 것이고 판정 축이 아니기 때문이다).
 */
function breakdownOf(routings: ItemRouting[], cutoff: number): GateBreakdown {
  const breakdown: GateBreakdown = {
    retrievalGate: 0,
    generationGate: 0,
    answered: 0,
    generationFailed: 0,
  };

  for (const routing of routings) {
    /**
     * **측정 실패가 게이트 판정보다 먼저다** (이슈 #352).
     *
     * 리랭크를 끝내 못 한 문항은 점수가 없어 컷에 따라 움직일 수 없다. 그런 문항을 게이트로
     * 흘리면 `top1Relevance: null`이 곧 「점수 미달」로 읽혀 **검색 게이트가 잘랐다고 위장**된다.
     * 측정하지 못한 것과 게이트가 자른 것은 다른 사실이므로 갈래를 먼저 가른다.
     */
    if (routing.failureReason !== null || routing.verdict?.status === 'failed') {
      breakdown.generationFailed += 1;
      continue;
    }

    const scoreAbstained =
      routing.top1Relevance === null || routing.top1Relevance < cutoff;
    if (routing.distanceAbstained || scoreAbstained) {
      breakdown.retrievalGate += 1;
      continue;
    }

    switch (routing.verdict?.status) {
      case 'insufficient':
        breakdown.generationGate += 1;
        break;
      // 'failed'는 위에서 이미 갈렸다 — 답변으로 세면 지표가 낙관 오염되기 때문이다
      default:
        // answerable · no_verdict(fail-open) · 미측정. 미방출은 프로덕션이 실제로 답하는 상태다
        breakdown.answered += 1;
    }
  }

  return breakdown;
}

/**
 * 생성에 실을 근거 — 리랭크 순서의 상위 K개다.
 *
 * 리랭크 결과가 비면 융합·코사인 순서를 그대로 쓴다 (프로덕션 `conversation-stream`의
 * 「재정렬 결과가 비면 기존 순서 유지」와 같은 폴백이다).
 */
function topEvidenceOf(
  results: HybridEvidence[],
  orderedChunkIds: string[] | null,
): HybridEvidence[] {
  if (orderedChunkIds === null) return results.slice(0, RETRIEVAL_TOP_K);

  const byChunkId = new Map(results.map((row) => [row.chunk.id, row]));
  const ordered = orderedChunkIds
    .map((chunkId) => byChunkId.get(chunkId))
    .filter((row): row is HybridEvidence => row !== undefined)
    .slice(0, RETRIEVAL_TOP_K);
  return ordered.length > 0 ? ordered : results.slice(0, RETRIEVAL_TOP_K);
}

/**
 * 컷 0~10 전 구간 재구성.
 *
 * **한 번의 실행으로 전 구간을 재구성할 수 있는 이유**는 컷이 라우팅에만 쓰이고 생성 입력을
 * 바꾸지 않기 때문이다 — 리랭크 top-5는 컷과 무관하게 정해지므로, 컷 c를 통과한 문항이 받는
 * 근거는 이 평가가 실제로 보낸 것과 같다. 그래서 재구성이 컷 c의 운영 동작과 정확히 일치한다.
 */
function cutSweepOf(routings: ItemRouting[]): CutSweepRow[] {
  const answerable = routings.filter((routing) => routing.item.kind === 'answerable');
  const abstain = routings.filter((routing) => routing.item.kind === 'abstain');

  return Array.from({ length: CUT_SWEEP_MAX + 1 }, (_, cutoff) => ({
    cutoff,
    answerable: breakdownOf(answerable, cutoff),
    abstain: breakdownOf(abstain, cutoff),
  }));
}

@Injectable()
export class RagEvalService {
  constructor(
    private readonly retrieval: RetrievalService,
    @Inject(RERANKER) private readonly reranker: Reranker,
    private readonly labelResolver: LabelResolver,
    private readonly llmGateway: LlmGateway,
  ) {}

  /**
   * 평가셋을 실행해 기준선 지표를 산출한다.
   *
   * 검색은 **K=30 한 번**으로 끝내고 Recall@5·MRR@5는 그 결과의 앞 5개로 계산한다 —
   * K를 달리해 두 번 조회하면 지표 사이에 코퍼스 변화가 끼어들 여지가 생긴다.
   *
   * 생성 게이트(§40)는 **컷과 무관하게 전 문항에** 잰다 — 컷은 라우팅에만 쓰이므로 한 번의
   * 실행으로 컷 전 구간을 사후 재구성할 수 있다.
   */
  async evaluate(items: EvalSetItem[], options: RagEvalOptions = {}): Promise<RagEvalReport> {
    const generationEnabled = options.generation ?? true;
    const routings: ItemRouting[] = [];
    const answerable = items.filter((item) => item.kind === 'answerable');
    const abstain = items.filter((item) => item.kind === 'abstain');

    // 라벨 부패는 여기서 터진다 — 채점 전에 끊어야 「검색이 나쁘다」로 오독되지 않는다 (기준 4)
    const labels = await this.labelResolver.resolve(answerable);
    const expectedByItem = new Map(
      labels.map((label) => [label.itemId, new Set(label.chunkIds)]),
    );

    const cutoff = this.retrieval.distanceCutoff;
    const scoreCutoff = this.retrieval.rerankScoreCutoff;
    const answerableDistances: number[] = [];
    const abstainDistances: number[] = [];
    const failures: EvalFailure[] = [];
    const abstainFailures: AbstainFailure[] = [];
    const overAbstainFailures: OverAbstainFailure[] = [];
    const answerableRelevances: number[] = [];
    const abstainRelevances: number[] = [];
    let hitAt5 = 0;
    let hitAtK = 0;
    let reciprocalRankSum = 0;
    // 하이브리드 대조 축 (docs/specs/31): 키워드 arm 단독 회수량과 합집합 상한.
    // 리랭크 지표를 읽으려면 「후보에 있기는 했는가」가 먼저 있어야 한다.
    let keywordHitAtK = 0;
    let unionHits = 0;
    // 컷 기권 시뮬레이션 (docs/specs/28 기준 8) — 런타임 게이트와 같은 판정:
    // 결과 0건 또는 top-1 > 컷이면 기권이다. 순위 지표는 이와 무관하게 계속 잰다(기준 9).
    let abstainedAbstain = 0;
    let abstainedAnswerable = 0;
    // 리랭크 시뮬레이션 (docs/specs/29 기준 10) — 런타임 3단 게이트와 같은 판정을 겹친다:
    // 거리 기권 || 점수 기권이 최종 기권이다. 평가는 측정 도구이므로 enabled 플래그와
    // 무관하게 항상 리랭크를 재서 「켰을 때 무엇이 달라지는가」에 답한다.
    let rerankHitAt5 = 0;
    let rerankReciprocalSum = 0;
    let rerankAbstainedAbstain = 0;
    let rerankAbstainedAnswerable = 0;

    /**
     * 검색 1회 — **운영과 같은 파이프라인을 탄다** (docs/specs/31).
     *
     * 리랭크는 플래그와 무관하게 항상 재지만(§29) 하이브리드는 그러지 않는다: 하이브리드는
     * 리랭커의 **입력 순서 자체**를 바꾸므로, 꺼진 배포에서 융합 순서 기준 리랭크 지표를
     * 보고하면 운영과 다른 파이프라인을 측정하는 셈이 된다.
     * 꺼진 경우 벡터 결과를 그대로 vectorRank만 채운 형태로 올린다 — 키워드 arm이 없으니
     * 키워드 Recall@K는 0, 합집합 커버리지는 벡터 Recall@30과 같아진다.
     */
    const searchOf = async (question: string): Promise<HybridEvidence[]> => {
      if (this.retrieval.hybridEnabled) {
        return this.retrieval.searchHybrid(question, undefined, EVAL_DIAGNOSTIC_K);
      }
      const rows = await this.retrieval.search(question, undefined, EVAL_DIAGNOSTIC_K);
      return rows.map((row, index) => ({ ...row, vectorRank: index + 1, keywordRank: null }));
    };

    /**
     * 한도 초과(429)면 백오프 후 재시도한다 (이슈 #352).
     *
     * 프로덕션은 리랭크 429를 코사인 폴백으로 흡수하지만 평가는 그럴 수 없다 — 점수가
     * 없으면 컷 스윕의 라우팅 축 자체가 사라지기 때문이다. 대신 기다린다: 이 실행에는
     * 기다릴 사람이 없고, 229문항 3시간을 429 하나에 잃는 것이 훨씬 비싸다.
     */
    const rerankOf = async (
      question: string,
      results: HybridEvidence[],
    ): Promise<RerankOutcome> => {
      try {
        const result = await withRateLimitRetry(
          () =>
            this.reranker.rerank(
              question,
              results.map((row) => ({
                chunkId: row.chunk.id,
                content: row.chunk.content,
                guidelineTitle: row.guideline.title,
              })),
            ),
          RERANK_RETRY_DELAYS_MS,
        );
        return {
          ok: true,
          orderedChunkIds: result.order,
          top1Relevance: result.top1Relevance,
        };
      } catch (error) {
        // 재시도를 다 써도 실패하면 그 문항만 잃는다 — 실행 전체를 잃지 않는다.
        // 점수·순위 지표는 건드리지 않는다: 모르는 값을 0으로 채우면 지표가 비관 오염된다
        return { ok: false, reason: `리랭크 실패: ${messageOf(error)}` };
      }
    };

    /**
     * 게이트 ④ 측정 (docs/specs/40 Out of scope 확장).
     *
     * **컷과 무관하게 전 문항에 부른다** — 컷은 라우팅 축일 뿐이고, 컷 c를 통과했을 때 생성이
     * 무엇을 받는지는 컷과 독립이다. 검색·리랭크를 다시 돌지 않고 이미 얻은 결과를 그대로
     * 넘기므로, 프로덕션 `conversation-stream`과 같은 순서(검색 → 리랭크 → top-5 → 생성)이면서
     * 호출 비용은 문항당 생성 1회만 는다.
     */
    const routeOf = async (
      item: EvalSetItem,
      args: {
        distanceAbstained: boolean;
        top1Relevance: number | null;
        results: HybridEvidence[];
        orderedChunkIds: string[] | null;
        /** 게이트 이전 단계의 측정 실패 — 있으면 생성을 부르지 않는다 (이슈 #352) */
        failureReason?: string;
      },
    ): Promise<void> => {
      const failureReason = args.failureReason ?? null;
      const routing: ItemRouting = {
        item,
        distanceAbstained: args.distanceAbstained,
        top1Relevance: args.top1Relevance,
        verdict: null,
        failureReason,
      };
      routings.push(routing);
      if (!generationEnabled) return;

      // 리랭크를 못 했으면 생성에 실을 순서가 없다 — 부르면 측정하지 않은 구성을 재는 셈이다
      if (failureReason !== null) {
        routing.verdict = {
          itemId: item.id,
          kind: item.kind,
          question: item.question,
          status: 'failed',
          cause: null,
          missingAspects: [],
          top1Relevance: args.top1Relevance,
          distanceAbstained: args.distanceAbstained,
          failureReason,
        };
        return;
      }

      const base = {
        itemId: item.id,
        kind: item.kind,
        question: item.question,
        cause: null,
        missingAspects: [],
        top1Relevance: args.top1Relevance,
        distanceAbstained: args.distanceAbstained,
        failureReason: null,
      } satisfies Omit<GenerationVerdictRecord, 'status'> & {
        cause: null;
        failureReason: null;
      };

      // 근거가 없으면 부를 것도 없다 — 이 문항은 컷과 무관하게 거리 게이트에 잘린다
      if (args.results.length === 0) {
        routing.verdict = { ...base, status: 'not_generated' };
        return;
      }

      try {
        const verdict = await this.generationVerdictOf(
          item.question,
          topEvidenceOf(args.results, args.orderedChunkIds),
        );
        if (verdict === undefined) {
          routing.verdict = { ...base, status: 'no_verdict' };
          return;
        }
        routing.verdict = {
          ...base,
          status: verdict.insufficientEvidence ? 'insufficient' : 'answerable',
          // 프로덕션 rag_generation_gate_total과 같은 판정 — 빈 축의 처방은 이 분포가 드러난 뒤다
          cause: verdict.insufficientEvidence
            ? verdict.missingAspects.length > 0
              ? 'model_verdict'
              : 'empty_aspects'
            : null,
          missingAspects: verdict.missingAspects,
        };
      } catch (error) {
        // 한 문항의 LLM 실패로 비싼 실행을 통째로 버리지 않는다. 조용히 빼지도 않는다 —
        // 답변으로 세면 지표가 낙관 오염되므로 별도 갈래로 남긴다 (docs/specs/27 계보)
        routing.verdict = { ...base, status: 'failed', failureReason: messageOf(error) };
      }
    };

    for (const item of answerable) {
      // 검색 1회로 두 arm 순위를 함께 얻는다 (docs/specs/31) — 벡터 원 지표는 vectorRank로
      // 계산되므로 §27·§28과 같은 축이 유지되고, 코퍼스 변화가 두 측정 사이에 끼어들 여지도 없다.
      const results = await searchOf(item.question);
      const vectorOrdered = orderByArm(results, 'vectorRank');
      if (vectorOrdered.length > 0) answerableDistances.push(vectorOrdered[0].distance);
      const distanceAbstained =
        vectorOrdered.length === 0 || vectorOrdered[0].distance > cutoff;
      if (distanceAbstained) abstainedAnswerable += 1;

      const expected = expectedByItem.get(item.id) ?? new Set<string>();
      const rank = rankIn(vectorOrdered, expected);
      const keywordRank = rankIn(orderByArm(results, 'keywordRank'), expected);
      if (keywordRank !== null) keywordHitAtK += 1;
      if (results.some((row) => expected.has(row.chunk.id))) unionHits += 1;

      if (rank !== null) {
        hitAtK += 1;
        if (rank <= RETRIEVAL_TOP_K) {
          hitAt5 += 1;
          reciprocalRankSum += 1 / rank;
        }
      }
      // 운영 K(5) 밖은 실패로 본다 — 30에서 찾았다는 사실은 foundAtRank가 따로 말해준다
      if (rank === null || rank > RETRIEVAL_TOP_K) {
        failures.push({
          itemId: item.id,
          question: item.question,
          foundAtRank: rank,
          keywordFoundAtRank: keywordRank,
        });
      }

      const reranked = results.length > 0 ? await rerankOf(item.question, results) : null;
      if (reranked !== null && !reranked.ok) {
        // 점수를 못 얻었으므로 리랭크 지표·기권 판정 어디에도 넣지 않는다 (이슈 #352)
        await routeOf(item, {
          distanceAbstained,
          top1Relevance: null,
          results,
          orderedChunkIds: null,
          failureReason: reranked.reason,
        });
      } else if (reranked !== null) {
        const { orderedChunkIds, top1Relevance } = reranked;
        answerableRelevances.push(top1Relevance);
        const scoreAbstained = top1Relevance < scoreCutoff;
        if (distanceAbstained || scoreAbstained) {
          rerankAbstainedAnswerable += 1;
          overAbstainFailures.push({
            itemId: item.id,
            question: item.question,
            top1Distance: vectorOrdered[0].distance,
            top1Relevance,
            gate: distanceAbstained && scoreAbstained ? 'both' : distanceAbstained ? 'distance' : 'score',
            foundAtRank: rank,
          });
        }
        const rerankZeroBased = orderedChunkIds
          .slice(0, RETRIEVAL_TOP_K)
          .findIndex((chunkId) => expected.has(chunkId));
        if (rerankZeroBased !== -1) {
          rerankHitAt5 += 1;
          rerankReciprocalSum += 1 / (rerankZeroBased + 1);
        }
        await routeOf(item, { distanceAbstained, top1Relevance, results, orderedChunkIds });
      } else {
        // 검색 0건 — 게이트가 아니라 코퍼스에 없다. 거리·점수 판정 자체가 성립하지 않는다
        rerankAbstainedAnswerable += 1;
        overAbstainFailures.push({
          itemId: item.id,
          question: item.question,
          top1Distance: Number.NaN,
          top1Relevance: null,
          gate: 'distance',
          foundAtRank: rank,
        });
        await routeOf(item, {
          distanceAbstained,
          top1Relevance: null,
          results,
          orderedChunkIds: null,
        });
      }
    }

    for (const item of abstain) {
      const results = await searchOf(item.question);
      const vectorOrdered = orderByArm(results, 'vectorRank');
      if (vectorOrdered.length > 0) abstainDistances.push(vectorOrdered[0].distance);
      const distanceAbstained =
        vectorOrdered.length === 0 || vectorOrdered[0].distance > cutoff;
      if (distanceAbstained) abstainedAbstain += 1;

      const reranked = results.length > 0 ? await rerankOf(item.question, results) : null;
      if (reranked !== null && !reranked.ok) {
        await routeOf(item, {
          distanceAbstained,
          top1Relevance: null,
          results,
          orderedChunkIds: null,
          failureReason: reranked.reason,
        });
      } else if (reranked !== null) {
        const { orderedChunkIds, top1Relevance } = reranked;
        abstainRelevances.push(top1Relevance);
        // abstain 문항도 생성을 탄다 — 「컷을 낮추면 생성 게이트가 무엇을 받아내는가」의 대상이
        // 바로 이들이다. 컷을 내려 검색 게이트를 통과한 기권 문항이 여기서 다시 걸릴 수 있다
        await routeOf(item, { distanceAbstained, top1Relevance, results, orderedChunkIds });
        if (distanceAbstained || top1Relevance < scoreCutoff) {
          rerankAbstainedAbstain += 1;
        } else {
          // 기권 실패는 숫자만으로는 손댈 수 없다 — 게이트를 조정하려면 어느 문항이 어떤
          // 근거를 몇 점으로 통과시켰는지 봐야 하고, 라벨 오류(사실은 답 가능한 문항)와
          // 진짜 게이트 실패도 이 목록 없이는 구분되지 않는다.
          abstainFailures.push({
            itemId: item.id,
            question: item.question,
            top1Distance: vectorOrdered[0].distance,
            top1Relevance,
            top1Guideline: results[0].guideline.title,
          });
        }
      } else {
        rerankAbstainedAbstain += 1;
        await routeOf(item, {
          distanceAbstained,
          top1Relevance: null,
          results,
          orderedChunkIds: null,
        });
      }
    }

    const denominator = answerable.length || 1;
    return {
      // **실행한 검색 파이프라인과 일치해야 한다** (spec 27 기준 5 개정, issue #246).
      // 이 필드의 존재 이유가 「값이 다르면 지표를 나란히 놓지 않는다」인데, 하이브리드(§31)로
      // 잰 지표에 벡터 정책 문자열이 붙어 정반대로 동작했다. 리랭크 파라미터는 여기 넣지 않는다 —
      // 리랭크는 검색을 바꾸지 않고, 점수 컷은 리포트의 별도 절이 싣는다.
      retrievalPolicyVersion: this.retrieval.hybridEnabled
        ? this.retrieval.hybridPolicyVersion()
        : this.retrieval.policyVersion,
      corpusChunkCount: await this.retrieval.countSearchableChunks(),
      answerableCount: answerable.length,
      abstainCount: abstain.length,
      recallAt5: hitAt5 / denominator,
      mrrAt5: reciprocalRankSum / denominator,
      recallAt30: hitAtK / denominator,
      keywordRecallAtK: keywordHitAtK / denominator,
      unionCoverage: unionHits / denominator,
      distanceCutoff: cutoff,
      rerankedRecallAt5: rerankHitAt5 / denominator,
      rerankedMrrAt5: rerankReciprocalSum / denominator,
      rerankedAbstainRecall: rerankAbstainedAbstain / (abstain.length || 1),
      rerankedOverAbstainRate: rerankAbstainedAnswerable / denominator,
      rerankScoreCutoff: scoreCutoff,
      abstainRecall: abstainedAbstain / (abstain.length || 1),
      overAbstainRate: abstainedAnswerable / denominator,
      distances: [
        distributionOf('answerable', answerableDistances),
        distributionOf('abstain', abstainDistances),
      ],
      relevances: [
        relevanceHistogramOf('answerable', answerableRelevances),
        relevanceHistogramOf('abstain', abstainRelevances),
      ],
      failures,
      abstainFailures,
      overAbstainFailures,
      // 미측정이면 빈 문자열이다 — 이 값은 「무엇이 verdict를 냈는가」의 식별자이고,
      // 부르지도 않은 프롬프트 버전을 싣는 것은 측정하지 않은 것을 측정했다고 말하는 셈이다
      promptVersion: generationEnabled ? PROMPT_VERSION : '',
      generationMeasured: generationEnabled,
      generationVerdicts: routings
        .map((routing) => routing.verdict)
        .filter((verdict): verdict is GenerationVerdictRecord => verdict !== null),
      cutSweep: cutSweepOf(routings),
    };
  }

  /**
   * 답변가능성 판정 1건. 델타는 버린다 — 이 평가가 재는 것은 답변 품질(§30 groundedness의 몫)이
   * 아니라 **게이트가 발화하는가**뿐이다.
   *
   * 판정 미방출은 오류가 아니라 정상 상태다(포트가 허용한다) — `undefined`로 그대로 올려
   * fail-open을 호출측이 답변으로 세게 한다.
   */
  private async generationVerdictOf(
    question: string,
    top: HybridEvidence[],
  ): Promise<LlmAnswerVerdict | undefined> {
    const evidence: LlmEvidenceContext[] = top.map((row, index) => ({
      marker: index + 1,
      content: row.chunk.content,
      guidelineTitle: row.guideline.title,
      sectionPath: row.section.path,
    }));

    /**
     * 한도 초과 재시도 (이슈 #352). 게이트웨이는 429를 만나면 프로바이더를 차단하고
     * 소진으로 보고하므로 **즉시 재시도는 무조건 실패한다** — 백오프가 차단 창을 넘겨야 한다.
     */
    const outcome = await withRateLimitRetry(
      () => this.llmGateway.stream({ question, evidence }, () => {}),
      GENERATION_RETRY_DELAYS_MS,
    );
    return outcome.verdict;
  }
}
