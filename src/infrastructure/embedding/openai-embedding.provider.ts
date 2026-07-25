/**
 * OpenAI Embeddings 어댑터 (docs/specs/14).
 * 배치로 나눠 호출하고 입력 순서를 보존하며, 차원이 스키마와 다르면 저장 전에 실패시킨다.
 */
import { OpenAiEmbeddingConfig } from './embedding.config';
import { EmbeddingProvider } from './embedding-provider.port';

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;

  constructor(private readonly config: OpenAiEmbeddingConfig) {
    this.model = config.model;
  }

  embed(_texts: string[]): Promise<number[][]> {
    throw new Error('OpenAiEmbeddingProvider.embed 미구현 (docs/specs/14)');
  }
}
