/**
 * 리랭커 포트 (docs/specs/29).
 *
 * `LlmProvider.streamAnswer`를 재사용하지 않는 이유는 §27과 같다 — 그 계약은 근거 인용 답변
 * 전용이고, 리랭크는 비스트리밍 단발 호출이다. 외부 유료 API라 **fake 치환 없이는 e2e 동결이
 * 성립하지 않는다**(architecture.md §3 포트 기준).
 */

export const RERANKER = Symbol('RERANKER');

export interface RerankCandidate {
  /** evidence_chunks.id — 재정렬 결과를 원본 행에 되돌리는 키 */
  chunkId: string;
  content: string;
  guidelineTitle: string;
}

export interface RerankResult {
  /** 관련도 순 chunk id — 상위 5개만 소비된다 */
  order: string[];
  /** 1위 후보가 질문에 답하는 정도 (0~10) — 점수 게이트의 원천 */
  top1Relevance: number;
}

export interface Reranker {
  /** GenerationRun 정책 버전에 기록되는 식별자 */
  readonly model: string;
  /** 실패는 예외로 던진다 — 호출측이 코사인 순위로 폴백한다 (docs/specs/29 기준 6) */
  rerank(question: string, candidates: RerankCandidate[]): Promise<RerankResult>;
}
