/**
 * EMBEDDING_PROVIDER 결정 (docs/specs/14).
 * OPENAI_API_KEY가 있으면 실 임베딩, 없으면 결정적 fake 단독(현행 동작 보존).
 */
import { EmbeddingProvider } from './embedding-provider.port';

export function createEmbeddingProvider(
  _env: NodeJS.ProcessEnv,
  _fake: EmbeddingProvider,
): EmbeddingProvider {
  throw new Error('createEmbeddingProvider 미구현 (docs/specs/14)');
}
