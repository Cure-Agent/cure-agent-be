/**
 * EMBEDDING_PROVIDER 결정 (docs/specs/14).
 * OPENAI_API_KEY가 있으면 실 임베딩, 없으면 결정적 fake 단독(현행 동작 보존).
 */
import { resolveEmbeddingConfig } from './embedding.config';
import { EmbeddingProvider } from './embedding-provider.port';
import { OpenAiEmbeddingProvider } from './openai-embedding.provider';

export function createEmbeddingProvider(
  env: NodeJS.ProcessEnv,
  fake: EmbeddingProvider,
): EmbeddingProvider {
  const config = resolveEmbeddingConfig(env);
  return config ? new OpenAiEmbeddingProvider(config) : fake;
}
