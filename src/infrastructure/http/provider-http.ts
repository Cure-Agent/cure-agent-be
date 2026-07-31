/**
 * 외부 프로바이더 공통 HTTP 유틸 (docs/specs/13·14).
 * 오류 등급화는 §11 4단 방어(재시도·서킷·rate-limit 차단)가 소비하는 계약이다.
 * 오류 계열은 호출 패키지가 정한다 — errorClass로 주입받아 llm·embedding 오류가 섞이지 않게 한다.
 */

/** 4단 방어가 분류에 사용하는 오류 속성 — LlmProviderError·EmbeddingProviderError 공통 */
export interface ProviderErrorOptions {
  retryable?: boolean;
  rateLimited?: boolean;
  retryAfterSec?: number;
}

type ProviderErrorClass<E extends Error> = new (
  message: string,
  options?: ProviderErrorOptions,
) => E;

export interface ProviderContext<E extends Error> {
  /** 오류 메시지 접두사 겸 프로바이더 식별자 */
  provider: string;
  errorClass: ProviderErrorClass<E>;
  signal?: AbortSignal;
  /** 첫 응답(헤더) 수신 상한 — 미지정 시 DEFAULT_FIRST_BYTE_TIMEOUT_MS */
  timeoutMs?: number;
}

/**
 * 첫 응답(헤더) 수신까지의 기본 상한 (architecture.md §11-1). 전체 상한 120s는 호출측이 부여한다.
 * 이 값은 TCP 연결이 아니라 "첫 바이트까지"를 잰다 — 비스트리밍 호출(임베딩)은 헤더와 본문이
 * 함께 오므로 10s로 충분하지만, LLM 스트리밍은 첫 토큰 생성까지 헤더가 오지 않으므로
 * 호출측이 timeoutMs로 더 긴 예산을 준다 (LLM_FIRST_BYTE_TIMEOUT_MS).
 */
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 10_000;

export async function fetchStream<E extends Error>(
  url: string,
  init: RequestInit,
  context: ProviderContext<E>,
): Promise<Response> {
  const {
    provider,
    errorClass: ErrorClass,
    signal,
    timeoutMs = DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  } = context;
  const firstByteTimeout = new AbortController();
  const timer = setTimeout(
    () => firstByteTimeout.abort(new Error(`${provider} 첫 응답 타임아웃 (${timeoutMs}ms)`)),
    timeoutMs,
  );
  const composed = signal
    ? AbortSignal.any([signal, firstByteTimeout.signal])
    : firstByteTimeout.signal;

  try {
    return await fetch(url, { ...init, signal: composed });
  } catch (error) {
    // 호출자 abort는 폴백·재시도 대상이 아니다 — 감싸지 않고 원 오류를 전파한다
    if (signal?.aborted) throw error;
    throw new ErrorClass(`${provider} 연결 실패: ${String(error)}`, { retryable: true });
  } finally {
    // 헤더를 받은 뒤에는 본문 스트리밍이 길어져도 이 타이머로 끊지 않는다
    clearTimeout(timer);
  }
}

export async function toProviderError<E extends Error>(
  response: Response,
  context: ProviderContext<E>,
): Promise<E> {
  const { provider, errorClass: ErrorClass } = context;
  const detail = await safeText(response);

  if (response.status === 429) {
    return new ErrorClass(`${provider} rate limit (429): ${detail}`, {
      rateLimited: true,
      retryAfterSec: parseRetryAfter(response.headers.get('retry-after')),
    });
  }
  if (response.status >= 500) {
    return new ErrorClass(`${provider} 서버 오류 (${response.status}): ${detail}`, {
      retryable: true,
    });
  }
  // 4xx는 대개 설정 오류(키·모델·요청 형식) — 재시도해도 같은 결과다
  return new ErrorClass(`${provider} 요청 실패 (${response.status}): ${detail}`, {
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
