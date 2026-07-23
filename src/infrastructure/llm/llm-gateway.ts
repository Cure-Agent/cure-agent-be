import { Inject, Injectable, Logger } from '@nestjs/common';
import { CircuitBreaker } from './circuit-breaker';
import {
  LLM_PROVIDERS,
  LlmProvider,
  LlmProviderError,
  LlmStreamRequest,
} from './llm-provider.port';
import { RateLimitBlockStore } from './rate-limit-block-store';
import { withRetry } from './retry-policy';

export interface LlmStreamOutcome {
  provider: string;
  text: string;
  latencyMs: number;
}

/** 게이트웨이 소진(전 프로바이더 불가) — 서비스에서 LLM_UNAVAILABLE로 매핑한다 */
export class LlmExhaustedError extends Error {
  constructor() {
    super('사용 가능한 LLM 프로바이더가 없습니다');
    this.name = 'LlmExhaustedError';
  }
}

/**
 * 우선순위 폴백 라우터 (architecture.md §11-4).
 * 차단(레이트리밋)·서킷 open 프로바이더는 건너뛰고, 첫 토큰 수신 전 실패 시 다음으로 폴백한다.
 * 첫 토큰 이후 실패는 폴백하지 않는다 — 중복 출력을 만들기 때문이며, 호출자가 실패 처리한다.
 */
@Injectable()
export class LlmGateway {
  private readonly logger = new Logger(LlmGateway.name);

  constructor(
    @Inject(LLM_PROVIDERS) private readonly providers: LlmProvider[],
    private readonly circuitBreaker: CircuitBreaker,
    private readonly rateLimitBlock: RateLimitBlockStore,
  ) {}

  async stream(
    request: LlmStreamRequest,
    onDelta: (delta: string) => Promise<void> | void,
  ): Promise<LlmStreamOutcome> {
    const startedAt = Date.now();

    for (const provider of this.providers) {
      if (this.rateLimitBlock.isBlocked(provider.name) || this.circuitBreaker.isOpen(provider.name)) {
        continue;
      }

      let firstTokenReceived = false;
      try {
        const text = await withRetry(async () => {
          let accumulated = '';
          for await (const delta of provider.streamAnswer(request)) {
            firstTokenReceived = true;
            accumulated += delta;
            await onDelta(delta);
          }
          return accumulated;
        });

        this.circuitBreaker.recordSuccess(provider.name);
        return { provider: provider.name, text, latencyMs: Date.now() - startedAt };
      } catch (error) {
        // 클라이언트 abort는 폴백 대상이 아니다 — 즉시 전파
        if (request.signal?.aborted) throw error;

        if (error instanceof LlmProviderError && error.options.rateLimited) {
          this.rateLimitBlock.block(provider.name, error.options.retryAfterSec);
        } else {
          this.circuitBreaker.recordFailure(provider.name);
        }
        this.logger.warn(`LLM 프로바이더 ${provider.name} 실패: ${String(error)}`);

        // 첫 토큰 이후 실패는 폴백 불가
        if (firstTokenReceived) throw error;
      }
    }

    throw new LlmExhaustedError();
  }
}
