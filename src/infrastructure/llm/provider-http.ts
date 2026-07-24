/**
 * 실 프로바이더 공통 HTTP 유틸 (docs/specs/13).
 * 오류 등급화는 §11 4단 방어(재시도·서킷·rate-limit 차단)가 소비하는 계약이다.
 */
import { LlmProviderError } from './llm-provider.port';

/** 응답 헤더 수신까지의 상한 (architecture.md §11-1). 전체 상한 120s는 호출측이 부여한다. */
const CONNECT_TIMEOUT_MS = 10_000;

export async function fetchStream(
  url: string,
  init: RequestInit,
  provider: string,
  signal?: AbortSignal,
): Promise<Response> {
  const connectTimeout = new AbortController();
  const timer = setTimeout(
    () => connectTimeout.abort(new Error(`${provider} 연결 타임아웃 (${CONNECT_TIMEOUT_MS}ms)`)),
    CONNECT_TIMEOUT_MS,
  );
  const composed = signal
    ? AbortSignal.any([signal, connectTimeout.signal])
    : connectTimeout.signal;

  try {
    return await fetch(url, { ...init, signal: composed });
  } catch (error) {
    // 호출자 abort는 폴백·재시도 대상이 아니다 — 감싸지 않고 원 오류를 전파한다
    if (signal?.aborted) throw error;
    throw new LlmProviderError(`${provider} 연결 실패: ${String(error)}`, { retryable: true });
  } finally {
    // 헤더를 받은 뒤에는 본문 스트리밍이 길어져도 이 타이머로 끊지 않는다
    clearTimeout(timer);
  }
}

export async function toProviderError(
  provider: string,
  response: Response,
): Promise<LlmProviderError> {
  const detail = await safeText(response);

  if (response.status === 429) {
    return new LlmProviderError(`${provider} rate limit (429): ${detail}`, {
      rateLimited: true,
      retryAfterSec: parseRetryAfter(response.headers.get('retry-after')),
    });
  }
  if (response.status >= 500) {
    return new LlmProviderError(`${provider} 서버 오류 (${response.status}): ${detail}`, {
      retryable: true,
    });
  }
  // 4xx는 대개 설정 오류(키·모델·요청 형식) — 재시도해도 같은 결과다
  return new LlmProviderError(`${provider} 요청 실패 (${response.status}): ${detail}`, {
    retryable: false,
  });
}

function parseRetryAfter(header: string | null): number | undefined {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '(본문 없음)';
  }
}

export function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
