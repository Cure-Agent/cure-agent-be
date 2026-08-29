import { Module } from '@nestjs/common';
import { createGuidanceStructurer } from './guidance/guidance-structurer.factory';
import { GUIDANCE_STRUCTURER } from './guidance/guidance-structurer.port';
import { LlmGateway } from './llm-gateway';
import { LLM_PROVIDERS, LlmProvider } from './llm-provider.port';
import { FakeLlmProvider } from './provider/fake-llm.provider';
import { createLlmProviders } from './provider/llm-providers.factory';
import { CircuitBreaker } from './resilience/circuit-breaker';
import { RateLimitBlockStore } from './resilience/rate-limit-block-store';
import { createTranslator } from './translation/translator.factory';
import { TRANSLATOR } from './translation/translator.port';

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
    // OPENAI_API_KEY 있으면 실물, 없으면 결정적 fake (docs/specs/33 — 리랭커 팩토리 선례)
    { provide: GUIDANCE_STRUCTURER, useFactory: () => createGuidanceStructurer(process.env) },
    // 번역 (docs/specs/42) — 같은 팩토리 선례. 질의(EN→KO)와 청크(KO→EN)가 같은 외부 경계다
    { provide: TRANSLATOR, useFactory: () => createTranslator(process.env) },
  ],
  exports: [LLM_PROVIDERS, LlmGateway, GUIDANCE_STRUCTURER, TRANSLATOR],
})
export class LlmModule {}
