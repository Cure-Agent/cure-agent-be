/**
 * 실 임베딩 프로바이더 설정 (docs/specs/14).
 * OPENAI_API_KEY·OPENAI_BASE_URL은 spec 13(LLM)과 공유하고, 모델만 별도 키를 쓴다.
 */
import { baseUrl, nonEmpty } from '../http/env';

const DEFAULT_MODEL = 'text-embedding-3-small'; // 1536차원 — EMBEDDING_DIMENSIONS와 정합
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAiEmbeddingConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export function resolveEmbeddingConfig(env: NodeJS.ProcessEnv): OpenAiEmbeddingConfig | null {
  const apiKey = nonEmpty(env.OPENAI_API_KEY);
  if (!apiKey) return null;

  return {
    apiKey,
    model: nonEmpty(env.OPENAI_EMBEDDING_MODEL) ?? DEFAULT_MODEL,
    baseUrl: baseUrl(env.OPENAI_BASE_URL, DEFAULT_BASE_URL),
  };
}
