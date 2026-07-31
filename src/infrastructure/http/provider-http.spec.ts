/**
 * fetchStream의 첫 응답(헤더) 타임아웃 계약.
 * 이 상한은 TCP 연결이 아니라 첫 바이트까지를 잰다 — 호출측이 timeoutMs로 예산을 조절한다.
 */
import { fetchStream, type ProviderErrorOptions } from './provider-http';

class TestProviderError extends Error {
  constructor(
    message: string,
    readonly options: ProviderErrorOptions = {},
  ) {
    super(message);
    this.name = 'TestProviderError';
  }
}

/** ms 뒤에 헤더가 도착하는 응답 — abort되면 abort 사유로 reject한다 */
function respondAfter(ms: number): void {
  jest.spyOn(global, 'fetch').mockImplementation(
    (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason));
        setTimeout(() => resolve(new Response('ok', { status: 200 })), ms);
      }),
  );
}

describe('fetchStream 첫 응답 타임아웃', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('timeoutMs를 지정하지 않으면 기본 10s에서 끊는다', async () => {
    respondAfter(20_000);
    const caught = fetchStream(
      'https://api.test.local/x',
      {},
      { provider: 'test', errorClass: TestProviderError },
    ).catch((error: unknown) => error);

    await jest.advanceTimersByTimeAsync(10_000);

    const error = await caught;
    expect(error).toBeInstanceOf(TestProviderError);
    expect((error as TestProviderError).message).toContain('첫 응답 타임아웃 (10000ms)');
    // 타임아웃은 일시 장애 — 재시도·폴백 대상이어야 한다
    expect((error as TestProviderError).options.retryable).toBe(true);
  });

  it('timeoutMs를 늘리면 10s 뒤 도착한 헤더도 버리지 않는다', async () => {
    respondAfter(20_000);
    const promise = fetchStream(
      'https://api.test.local/x',
      {},
      { provider: 'test', errorClass: TestProviderError, timeoutMs: 45_000 },
    );

    await jest.advanceTimersByTimeAsync(20_000);

    await expect(promise).resolves.toMatchObject({ status: 200 });
  });
});
