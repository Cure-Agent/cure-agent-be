// 이슈 #352 수용 기준 동결 테스트 — 구현 중 수정 금지
import {
  GENERATION_RETRY_DELAYS_MS,
  RERANK_RETRY_DELAYS_MS,
  isRateLimited,
  type Sleep,
  withRateLimitRetry,
} from './eval-retry';
import { LlmExhaustedError } from '../../infrastructure/llm/llm-gateway';
import { LlmProviderError } from '../../infrastructure/llm/llm-provider.port';
import { RerankerError } from '../../infrastructure/retrieval/openai-reranker';

const RECOVERED_VALUE = '재시도로 회수한 값';

function rateLimitError(message = '의도한 429'): RerankerError {
  return new RerankerError(message, { rateLimited: true });
}

function recordingSleep(calls: number[]): Sleep {
  return (ms) => {
    calls.push(ms);
    return Promise.resolve();
  };
}

/**
 * A1·A2와 음성 판정·상수 기준은 스텁도 원래 만족할 수 있다. 각 `it()`이 공허하게
 * 통과하지 않도록, 그런 기준에는 최소 한 번의 429 회수 양성 대조를 함께 둔다.
 */
async function expectRetryCapability(): Promise<void> {
  let attemptCalls = 0;
  const sleepCalls: number[] = [];
  const received = await withRateLimitRetry(
    () => {
      attemptCalls += 1;
      if (attemptCalls === 1) return Promise.reject(rateLimitError());
      return Promise.resolve(RECOVERED_VALUE);
    },
    [1],
    recordingSleep(sleepCalls),
  );

  expect(received).toBe(RECOVERED_VALUE);
  expect(attemptCalls).toBe(2);
  expect(sleepCalls).toEqual([1]);
}

function expectPositiveRateLimitControl(): void {
  expect(isRateLimited(rateLimitError('양성 대조 429'))).toBe(true);
}

describe('이슈 #352: 평가 경로 429 재시도', () => {
  describe('A. withRateLimitRetry', () => {
    it('기준 A1: 첫 시도가 성공하면 attempt를 한 번만 호출하고 그 값을 반환한다', async () => {
      let attemptCalls = 0;
      const expected = { recovered: false };

      const received = await withRateLimitRetry(
        () => {
          attemptCalls += 1;
          return Promise.resolve(expected);
        },
        [3, 7],
        recordingSleep([]),
      );

      expect(attemptCalls).toBe(1);
      expect(received).toBe(expected);
      await expectRetryCapability();
    });

    it('기준 A2: 첫 시도가 성공하면 sleep을 한 번도 호출하지 않는다', async () => {
      const sleepCalls: number[] = [];

      await withRateLimitRetry(
        () => Promise.resolve('첫 시도 성공'),
        [3, 7],
        recordingSleep(sleepCalls),
      );

      expect(sleepCalls).toHaveLength(0);
      await expectRetryCapability();
    });

    it('기준 A3: 한도 초과 뒤 다음 시도가 성공하면 최종 값을 반환한다', async () => {
      let attemptCalls = 0;

      const received = await withRateLimitRetry(
        () => {
          attemptCalls += 1;
          return attemptCalls === 1
            ? Promise.reject(rateLimitError('첫 시도 429'))
            : Promise.resolve(RECOVERED_VALUE);
        },
        [11],
        recordingSleep([]),
      );

      expect(received).toBe(RECOVERED_VALUE);
    });

    it('기준 A4: 한도 초과 뒤 성공하면 attempt 호출 수는 2다', async () => {
      let attemptCalls = 0;

      await withRateLimitRetry(
        () => {
          attemptCalls += 1;
          return attemptCalls === 1
            ? Promise.reject(rateLimitError('첫 시도 429'))
            : Promise.resolve(RECOVERED_VALUE);
        },
        [11],
        recordingSleep([]),
      );

      expect(attemptCalls).toBe(2);
    });

    it('기준 A5: 재시도 사이의 sleep은 delaysMs를 순서대로 소비한다', async () => {
      const delays = [3, 7, 13] as const;
      const sleepCalls: number[] = [];
      let attemptCalls = 0;

      await withRateLimitRetry(
        () => {
          attemptCalls += 1;
          return attemptCalls <= delays.length
            ? Promise.reject(rateLimitError(`${attemptCalls}번째 429`))
            : Promise.resolve(RECOVERED_VALUE);
        },
        delays,
        recordingSleep(sleepCalls),
      );

      expect(sleepCalls).toEqual(delays);
    });

    it('기준 A6: 한도 초과가 아닌 오류는 재시도하지 않아 attempt 호출 수가 1이다', async () => {
      const error = new Error('영구 실패');
      let attemptCalls = 0;

      await withRateLimitRetry(
        () => {
          attemptCalls += 1;
          return Promise.reject(error);
        },
        [3, 7],
        recordingSleep([]),
      ).catch(() => undefined);

      expect(attemptCalls).toBe(1);
      await expectRetryCapability();
    });

    it('기준 A7: 한도 초과가 아닌 오류는 같은 오류 객체로 전파된다', async () => {
      const error = new Error('그대로 전파할 오류');

      await expect(
        withRateLimitRetry(
          () => Promise.reject(error),
          [3, 7],
          recordingSleep([]),
        ),
      ).rejects.toBe(error);
      await expectRetryCapability();
    });

    it('기준 A8: 지연을 다 쓴 뒤에는 마지막 한도 초과 오류를 던진다', async () => {
      const delays = [3, 7] as const;
      const errors = [
        rateLimitError('첫 오류'),
        rateLimitError('둘째 오류'),
        rateLimitError('마지막 오류'),
      ];
      let attemptCalls = 0;

      await expect(
        withRateLimitRetry(
          () => {
            const error = errors[attemptCalls];
            attemptCalls += 1;
            return Promise.reject(error);
          },
          delays,
          recordingSleep([]),
        ),
      ).rejects.toBe(errors[errors.length - 1]);
    });

    it('기준 A9: 재시도 소진 시 attempt 호출 수는 delaysMs.length + 1이다', async () => {
      const delays = [3, 7, 13] as const;
      let attemptCalls = 0;

      await withRateLimitRetry(
        () => {
          attemptCalls += 1;
          return Promise.reject(rateLimitError(`${attemptCalls}번째 429`));
        },
        delays,
        recordingSleep([]),
      ).catch(() => undefined);

      expect(attemptCalls).toBe(delays.length + 1);
    });

    it('기준 A10: 재시도 소진 시 sleep 호출 수는 delaysMs.length다', async () => {
      const delays = [3, 7, 13] as const;
      const sleepCalls: number[] = [];

      await withRateLimitRetry(
        () => Promise.reject(rateLimitError('계속되는 429')),
        delays,
        recordingSleep(sleepCalls),
      ).catch(() => undefined);

      expect(sleepCalls).toHaveLength(delays.length);
    });
  });

  describe('B. isRateLimited', () => {
    it('기준 B1: rateLimited=true인 RerankerError를 한도 초과로 판정한다', () => {
      expect(
        isRateLimited(
          new RerankerError('리랭커 429', { rateLimited: true }),
        ),
      ).toBe(true);
    });

    it('기준 B2: rateLimited=true인 LlmProviderError를 한도 초과로 판정한다', () => {
      expect(
        isRateLimited(
          new LlmProviderError('생성 프로바이더 429', {
            rateLimited: true,
          }),
        ),
      ).toBe(true);
    });

    it('기준 B3: LlmExhaustedError를 한도 초과로 판정한다', () => {
      expect(isRateLimited(new LlmExhaustedError())).toBe(true);
    });

    it('기준 B4: options가 없거나 rateLimited가 아닌 일반 오류는 한도 초과가 아니다', () => {
      expect(isRateLimited(new Error('일반 오류'))).toBe(false);
      expect(isRateLimited(new RerankerError('옵션 없는 오류'))).toBe(false);
      expectPositiveRateLimitControl();
    });

    it('기준 B5: retryable=true여도 rateLimited가 아니면 한도 초과가 아니다', () => {
      expect(
        isRateLimited(
          new LlmProviderError('5xx 오류', { retryable: true }),
        ),
      ).toBe(false);
      expectPositiveRateLimitControl();
    });

    it('기준 B6: Error가 아닌 값은 한도 초과가 아니다', () => {
      const values: unknown[] = [
        null,
        undefined,
        '429',
        429,
        true,
        {},
        { options: { rateLimited: true } },
      ];

      for (const value of values) {
        expect(isRateLimited(value)).toBe(false);
      }
      expectPositiveRateLimitControl();
    });
  });

  describe('C. 지연 스케줄', () => {
    it('기준 C1: 생성 재시도 지연의 누적 합은 60,000ms를 넘는다', async () => {
      const total = GENERATION_RETRY_DELAYS_MS.reduce(
        (sum, delay) => sum + delay,
        0,
      );

      expect(total).toBeGreaterThan(60_000);
      await expectRetryCapability();
    });

    it('기준 C2: 리랭크 재시도 지연 스케줄은 비어 있지 않다', async () => {
      expect(RERANK_RETRY_DELAYS_MS.length).toBeGreaterThan(0);
      await expectRetryCapability();
    });

    it('기준 C3: 리랭크와 생성 재시도 스케줄은 모두 감소하지 않는다', async () => {
      for (const schedule of [
        RERANK_RETRY_DELAYS_MS,
        GENERATION_RETRY_DELAYS_MS,
      ]) {
        for (let index = 1; index < schedule.length; index += 1) {
          expect(schedule[index]).toBeGreaterThanOrEqual(schedule[index - 1]);
        }
      }
      await expectRetryCapability();
    });
  });
});
