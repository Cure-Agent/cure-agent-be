/**
 * RAG 검색 기준선 측정 (docs/specs/27 수용 기준 5).
 *
 * Recall@5·MRR@5는 운영 지표이고 **Recall@30은 진단용**이다 — 후보군에 정답이 있는데 순서가
 * 나쁜 것(리랭커)과 애초에 못 찾는 것(하이브리드·모델 교체)을 가르는 축이기 때문이다.
 */
import { Inject, Injectable } from '@nestjs/common';
import { RetrievalService, RETRIEVAL_TOP_K } from '../../infrastructure/retrieval/retrieval.service';
import { RERANKER, Reranker } from '../../infrastructure/retrieval/reranker.port';
import { EvalKind, EvalSetItem } from './evalset.types';
import { LabelResolver } from './label-resolver';

/** 진단용 상한 — 이 K까지 열어도 못 찾으면 순서 문제가 아니다 */
export const EVAL_DIAGNOSTIC_K = 30;

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
  /** 정답이 나타난 순위(1-based). 30까지 열어도 없으면 null */
  foundAtRank: number | null;
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
  failures: EvalFailure[];
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

@Injectable()
export class RagEvalService {
  constructor(
    private readonly retrieval: RetrievalService,
    @Inject(RERANKER) private readonly reranker: Reranker,
    private readonly labelResolver: LabelResolver,
  ) {}

  /**
   * 평가셋을 실행해 기준선 지표를 산출한다.
   *
   * 검색은 **K=30 한 번**으로 끝내고 Recall@5·MRR@5는 그 결과의 앞 5개로 계산한다 —
   * K를 달리해 두 번 조회하면 지표 사이에 코퍼스 변화가 끼어들 여지가 생긴다.
   */
  async evaluate(items: EvalSetItem[]): Promise<RagEvalReport> {
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
    let hitAt5 = 0;
    let hitAtK = 0;
    let reciprocalRankSum = 0;
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

    const rerankOf = async (
      question: string,
      results: Awaited<ReturnType<RetrievalService['search']>>,
    ): Promise<{ orderedChunkIds: string[]; top1Relevance: number }> => {
      const result = await this.reranker.rerank(
        question,
        results.map((row) => ({
          chunkId: row.chunk.id,
          content: row.chunk.content,
          guidelineTitle: row.guideline.title,
        })),
      );
      return { orderedChunkIds: result.order, top1Relevance: result.top1Relevance };
    };

    for (const item of answerable) {
      const results = await this.retrieval.search(item.question, undefined, EVAL_DIAGNOSTIC_K);
      if (results.length > 0) answerableDistances.push(results[0].distance);
      const distanceAbstained = results.length === 0 || results[0].distance > cutoff;
      if (distanceAbstained) abstainedAnswerable += 1;

      const expected = expectedByItem.get(item.id) ?? new Set<string>();
      const zeroBased = results.findIndex((row) => expected.has(row.chunk.id));
      const rank = zeroBased === -1 ? null : zeroBased + 1;

      if (rank !== null) {
        hitAtK += 1;
        if (rank <= RETRIEVAL_TOP_K) {
          hitAt5 += 1;
          reciprocalRankSum += 1 / rank;
        }
      }
      // 운영 K(5) 밖은 실패로 본다 — 30에서 찾았다는 사실은 foundAtRank가 따로 말해준다
      if (rank === null || rank > RETRIEVAL_TOP_K) {
        failures.push({ itemId: item.id, question: item.question, foundAtRank: rank });
      }

      if (results.length > 0) {
        const { orderedChunkIds, top1Relevance } = await rerankOf(item.question, results);
        if (distanceAbstained || top1Relevance < scoreCutoff) rerankAbstainedAnswerable += 1;
        const rerankZeroBased = orderedChunkIds
          .slice(0, RETRIEVAL_TOP_K)
          .findIndex((chunkId) => expected.has(chunkId));
        if (rerankZeroBased !== -1) {
          rerankHitAt5 += 1;
          rerankReciprocalSum += 1 / (rerankZeroBased + 1);
        }
      } else {
        rerankAbstainedAnswerable += 1;
      }
    }

    for (const item of abstain) {
      const results = await this.retrieval.search(item.question, undefined, EVAL_DIAGNOSTIC_K);
      if (results.length > 0) abstainDistances.push(results[0].distance);
      const distanceAbstained = results.length === 0 || results[0].distance > cutoff;
      if (distanceAbstained) abstainedAbstain += 1;

      if (results.length > 0) {
        const { top1Relevance } = await rerankOf(item.question, results);
        if (distanceAbstained || top1Relevance < scoreCutoff) rerankAbstainedAbstain += 1;
      } else {
        rerankAbstainedAbstain += 1;
      }
    }

    const denominator = answerable.length || 1;
    return {
      retrievalPolicyVersion: this.retrieval.policyVersion,
      corpusChunkCount: await this.retrieval.countSearchableChunks(),
      answerableCount: answerable.length,
      abstainCount: abstain.length,
      recallAt5: hitAt5 / denominator,
      mrrAt5: reciprocalRankSum / denominator,
      recallAt30: hitAtK / denominator,
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
      failures,
    };
  }
}
