import { Module } from '@nestjs/common';
import { CircuitBreaker } from './circuit-breaker';
import { FakeLlmProvider } from './fake-llm.provider';
import { LlmGateway } from './llm-gateway';
import { LLM_PROVIDERS, LlmProvider } from './llm-provider.port';
import { createLlmProviders } from './llm-providers.factory';
import { RateLimitBlockStore } from './rate-limit-block-store';

/**
 * 프로바이더 구성은 env가 결정한다 (docs/specs/13):
 * 키가 있으면 실 프로바이더(openai → anthropic), 하나도 없으면 결정적 fake 단독(docs/specs/06).
 * ConfigModule.forRoot가 .env를 process.env에 적재한 뒤 이 팩토리가 평가된다.
 */
@Module({
  providers: [
    FakeLlmProvider,
    {
      provide: LLM_PROVIDERS,
      inject: [FakeLlmProvider],
      useFactory: (fake: FakeLlmProvider): LlmProvider[] =>
        createLlmProviders(process.env, fake),
    },
    CircuitBreaker,
    RateLimitBlockStore,
    LlmGateway,
  ],
  exports: [LLM_PROVIDERS, LlmGateway],
})
export class LlmModule {}
