/**
 * RAG 검색 기준선 측정 (docs/specs/27 수용 기준 5).
 *
 * Recall@5·MRR@5는 운영 지표이고 **Recall@30은 진단용**이다 — 후보군에 정답이 있는데 순서가
 * 나쁜 것(리랭커)과 애초에 못 찾는 것(하이브리드·모델 교체)을 가르는 축이기 때문이다.
 */
import { Injectable } from '@nestjs/common';
import { EvalKind, EvalSetItem } from './evalset.types';

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
  distances: DistanceDistribution[];
  failures: EvalFailure[];
}

@Injectable()
export class RagEvalService {
  /**
   * TODO(docs/specs/27 기준 5): 평가셋을 실행해 기준선 지표를 산출한다.
   * answerable은 K=30으로 검색해 Recall@5·MRR@5·Recall@30을, abstain은 top-1 거리만 본다.
   */
  evaluate(_items: EvalSetItem[]): Promise<RagEvalReport> {
    return Promise.reject(new Error('TODO: docs/specs/27 기준 5 미구현'));
  }
}
