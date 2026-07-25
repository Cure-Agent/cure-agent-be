/**
 * 실 임베딩 프로바이더 설정 (docs/specs/14).
 * OPENAI_API_KEY·OPENAI_BASE_URL은 spec 13(LLM)과 공유하고, 모델만 별도 키를 쓴다.
 */

export interface OpenAiEmbeddingConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export function resolveEmbeddingConfig(_env: NodeJS.ProcessEnv): OpenAiEmbeddingConfig | null {
  throw new Error('resolveEmbeddingConfig 미구현 (docs/specs/14)');
}
