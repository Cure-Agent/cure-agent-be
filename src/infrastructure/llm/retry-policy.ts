import { LlmProviderError } from './llm-provider.port';

const MAX_ATTEMPTS = 2;
const BACKOFF_MS = 300;

/**
 * 일시 오류 재시도 (architecture.md §11-1).
 * 스트리밍 특성상 첫 토큰 수신 전 실패에만 적용한다 — 중간 실패 재시도는 중복 출력을 만든다.
 */
export async function withRetry<T>(attempt: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof LlmProviderError && error.options.retryable === true;
      if (!retryable || i === MAX_ATTEMPTS - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * (i + 1)));
    }
  }
  throw lastError;
}
