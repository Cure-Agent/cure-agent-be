import { Module } from '@nestjs/common';
import { LLM_PROVIDERS } from './llm-provider.port';

@Module({
  providers: [{ provide: LLM_PROVIDERS, useValue: [] }],
  exports: [LLM_PROVIDERS],
})
export class LlmModule {}
