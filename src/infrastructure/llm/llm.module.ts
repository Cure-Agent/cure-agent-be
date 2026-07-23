import { Module } from '@nestjs/common';
import { CircuitBreaker } from './circuit-breaker';
import { FakeLlmProvider } from './fake-llm.provider';
import { LlmGateway } from './llm-gateway';
import { LLM_PROVIDERS, LlmProvider } from './llm-provider.port';
import { RateLimitBlockStore } from './rate-limit-block-store';

/**
 * 기본 프로바이더는 결정적 fake (docs/specs/06).
 * 실 프로바이더(OpenAI/Anthropic)는 spec 07에서 이 배열에 우선순위로 추가된다.
 */
@Module({
  providers: [
    FakeLlmProvider,
    {
      provide: LLM_PROVIDERS,
      inject: [FakeLlmProvider],
      useFactory: (fake: FakeLlmProvider): LlmProvider[] => [fake],
    },
    CircuitBreaker,
    RateLimitBlockStore,
    LlmGateway,
  ],
  exports: [LLM_PROVIDERS, LlmGateway],
})
export class LlmModule {}
