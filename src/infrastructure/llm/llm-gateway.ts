import { Inject, Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../../global/observability/metrics/metrics.service';
import { RealTimeAlertSender } from '../../global/observability/real-time-alert.sender';
import {
  LLM_PROVIDERS,
  LlmProvider,
  LlmProviderError,
  LlmStreamRequest,
} from './llm-provider.port';
import { CircuitBreaker } from './resilience/circuit-breaker';
import { RateLimitBlockStore } from './resilience/rate-limit-block-store';
import { withRetry } from './resilience/retry-policy';

export interface LlmStreamOutcome {
  provider: string;
  /** 실사용 모델 — 프로바이더가 제공한 경우에만 (docs/specs/13) */
  model?: string;
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
    private readonly alertSender: RealTimeAlertSender,
    private readonly metrics: MetricsService,
  ) {}

  async stream(
    request: LlmStreamRequest,
    onDelta: (delta: string) => Promise<void> | void,
  ): Promise<LlmStreamOutcome> {
    const startedAt = Date.now();

    for (const provider of this.providers) {
      const circuitOpen = this.circuitBreaker.isOpen(provider.name);
      // 쿨다운 만료로 닫히는 것도 이 시점에 드러나므로 매 시도마다 gauge를 맞춘다
      this.metrics.setLlmCircuitOpen(provider.name, circuitOpen);

      if (this.rateLimitBlock.isBlocked(provider.name) || circuitOpen) {
        this.metrics.recordLlmOutcome(provider.name, 'skipped');
        continue;
      }

      const attemptStartedAt = Date.now();
      let firstTokenReceived = false;
      try {
        // 토큰 usage 보고 경로를 여기서 주입한다 — 서비스 계층 호출자는 관여하지 않는다
        const providerRequest: LlmStreamRequest = {
          ...request,
          onUsage: (usage) =>
            this.metrics.recordLlmTokens(
              provider.name,
              provider.model ?? 'unknown',
              usage.inputTokens,
              usage.outputTokens,
            ),
        };

        const text = await withRetry(async () => {
          let accumulated = '';
          for await (const delta of provider.streamAnswer(providerRequest)) {
            firstTokenReceived = true;
            accumulated += delta;
            await onDelta(delta);
          }
          return accumulated;
        });

        this.circuitBreaker.recordSuccess(provider.name);
        this.metrics.setLlmCircuitOpen(provider.name, false);
        this.metrics.recordLlmOutcome(provider.name, 'success');
        this.metrics.recordLlmDuration(provider.name, (Date.now() - attemptStartedAt) / 1000);
        return {
          provider: provider.name,
          model: provider.model,
          text,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        // 클라이언트 abort는 폴백 대상이 아니다 — 즉시 전파.
        // 서비스 실패가 아니므로 지표에도 남기지 않는다(에러율 왜곡 방지)
        if (request.signal?.aborted) throw error;

        this.metrics.recordLlmDuration(provider.name, (Date.now() - attemptStartedAt) / 1000);

        if (error instanceof LlmProviderError && error.options.rateLimited) {
          this.rateLimitBlock.block(provider.name, error.options.retryAfterSec);
          this.metrics.recordLlmOutcome(provider.name, 'rate_limited');
        } else {
          this.circuitBreaker.recordFailure(provider.name);
          this.metrics.recordLlmOutcome(provider.name, 'failure');
          // 이 지점 도달 = 시도 전 not-open이었으므로, 기록 직후 open이면 곧 전이다 (§14)
          if (this.circuitBreaker.isOpen(provider.name)) {
            this.metrics.setLlmCircuitOpen(provider.name, true);
            this.alertSender.send({
              title: 'LLM_CIRCUIT_OPEN',
              detail: `프로바이더 ${provider.name} 서킷 open — 연속 실패 임계 초과`,
            });
          }
        }
        this.logger.warn(`LLM 프로바이더 ${provider.name} 실패: ${String(error)}`);

        // 첫 토큰 이후 실패는 폴백 불가
        if (firstTokenReceived) throw error;
      }
    }

    // 전 프로바이더 소진 — 사용자 영향이 생기는 지점이므로 즉시 알림 (§14)
    this.metrics.recordLlmExhausted();
    this.alertSender.send({
      title: 'LLM_EXHAUSTED',
      detail: '사용 가능한 LLM 프로바이더가 없습니다',
    });
    throw new LlmExhaustedError();
  }
}
