/**
 * 임베딩 포트 (architecture.md §3 — 포트는 llm/embedding/retrieval에만).
 * 실 프로바이더 연결은 6단계(retrieval)에서, 이번 스텝은 fake만 배선한다.
 */
export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export interface EmbeddingProvider {
  /** 입력 순서를 보존한 임베딩 배열을 반환한다. */
  embed(texts: string[]): Promise<number[][]>;
}
