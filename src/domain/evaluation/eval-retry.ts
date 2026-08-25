/**
 * 평가 경로 전용 429 재시도 (이슈 #352).
 *
 * **프로덕션 요청 경로는 이 모듈을 쓰지 않는다.** 거기서는 429가 정상 처리 경로다 —
 * 리랭크 429는 `conversation-stream`이 코사인 폴백으로 흡수하고, 생성 429는 게이트웨이가
 * 프로바이더를 차단해 다음 프로바이더로 넘긴다. 사용자를 기다리게 하는 대신 즉시 응답한다.
 *
 * 평가는 반대다. 229문항 3시간짜리 실행에서 429 하나에 전부를 잃는 것보다 몇 초 기다리는
 * 편이 낫다 — 기다릴 사람이 없고, 잃을 것이 크다. 그래서 회복 전략이 갈리고, 갈리는 지점이
 * 이 모듈이다.
 */
import { LlmExhaustedError } from '../../infrastructure/llm/llm-gateway';

/**
 * 리랭크 백오프. 429는 짧게 풀린다 — 관측된 응답이 "try again in 675ms"였다.
 * 리랭커는 차단 스토어를 거치지 않으므로 곧바로 재시도할 수 있다.
 */
export const RERANK_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 12_000];

/**
 * 생성 백오프. **즉시 재시도는 무조건 실패한다** — `RateLimitBlockStore`가 429를 만난
 * 프로바이더를 기본 60초 차단하고, 단일 프로바이더면 그동안 모든 시도가 `LlmExhaustedError`로
 * 즉시 떨어진다. 그래서 누적 대기가 그 창을 넘어야 재시도가 의미를 갖는다.
 *
 * 게이트웨이가 `retryAfterSec`를 삼켜 `LlmExhaustedError`로 바꾸므로 정확한 대기 시간은
 * 알 수 없다 — 보수적으로 잡는다.
 */
export const GENERATION_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000, 60_000];

/**
 * 이 오류가 한도 초과인가.
 *
 * `LlmExhaustedError`를 보되 **`rateLimited`가 참인 것만** 세는 이유: 게이트웨이가 429를
 * 프로바이더 차단으로 바꾸고 소진으로 보고하므로 평가에서 관측되는 429의 주된 형태가
 * 이것이지만, **429가 아닌 총실패(키 오류·서킷 open)도 같은 타입**이다. 둘을 묶으면 기다려도
 * 풀리지 않는 실패에까지 백오프를 물어 229문항 실행이 몇 시간씩 늘어난다.
 */
export function isRateLimited(error: unknown): boolean {
  // 소진 자체가 아니라 **소진의 원인**을 본다 (TEST-DISPUTE 정정, 이슈 #352).
  // 키 오류·서킷 open도 같은 타입으로 오는데, 그것들은 기다려도 풀리지 않는다 —
  // 구분하지 않으면 모든 총실패가 한도 초과 백오프를 물어 실행이 몇 시간씩 늘어난다.
  if (error instanceof LlmExhaustedError) return error.rateLimited;
  if (!(error instanceof Error)) return false;
  // RerankerError·LlmProviderError가 공유하는 형태다 — 클래스로 좁히지 않는 이유는
  // 한도 초과를 이 모양으로 실어 나르는 타입이 앞으로 더 생겨도 그대로 잡히게 하기 위해서다.
  // `retryable`은 보지 않는다: 5xx 등급은 각 프로바이더의 기존 재시도가 다루는 다른 축이다.
  const options = (error as { options?: { rateLimited?: unknown } }).options;
  return options?.rateLimited === true;
}

/** 테스트가 가짜 시계를 주입한다 — 실제 대기가 유닛 테스트를 분 단위로 늘리지 않게 */
export type Sleep = (ms: number) => Promise<void>;

/**
 * 한도 초과면 `delaysMs`를 순서대로 소비하며 재시도한다.
 * 한도 초과가 아닌 오류는 재시도하지 않고 즉시 전파한다 — 영구 실패를 기다리는 것은 낭비다.
 * 지연을 다 쓰고도 실패하면 마지막 오류를 던진다.
 */
export async function withRateLimitRetry<T>(
  attempt: () => Promise<T>,
  delaysMs: readonly number[],
  sleep: Sleep = defaultSleep,
): Promise<T> {
  // 지연 수만큼만 더 시도한다 — 지연 하나가 재시도 하나를 산다
  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (index >= delaysMs.length || !isRateLimited(error)) throw error;
      await sleep(delaysMs[index]);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
