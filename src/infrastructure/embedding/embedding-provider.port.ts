/**
 * 임베딩 포트 (architecture.md §3 — 포트는 llm/embedding/retrieval에만).
 * 실 프로바이더(OpenAI) 연동은 docs/specs/14.
 */
import { ProviderErrorOptions } from '../http/provider-http';

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export interface EmbeddingProvider {
  /**
   * 임베딩 모델 식별자. 벡터의 좌표계를 결정하므로 청크에 함께 기록되고,
   * 검색은 같은 모델로 만들어진 청크만 대상으로 한다 (docs/specs/14).
   */
  readonly model: string;
  /** 입력 순서를 보존한 임베딩 배열을 반환한다. */
  embed(texts: string[]): Promise<number[][]>;
}

/** 임베딩 프로바이더 오류 — 게이트웨이가 없으므로 호출자(인제스트·스트림)로 그대로 전파된다 */
export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    readonly options: ProviderErrorOptions = {},
  ) {
    super(message);
    this.name = 'EmbeddingProviderError';
  }
}
