/**
 * OpenAI Chat Completions 스트리밍 어댑터 (docs/specs/13).
 * 오류는 LlmProviderError로 등급화해 §11 4단 방어가 소비한다 — abort는 감싸지 않고 원 오류 전파.
 */
import { OpenAiProviderConfig } from './llm.config';
import { LlmProvider, LlmStreamRequest } from './llm-provider.port';

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  readonly model: string;

  constructor(private readonly config: OpenAiProviderConfig) {
    this.model = config.model;
  }

  async *streamAnswer(_request: LlmStreamRequest): AsyncIterable<string> {
    throw new Error('OpenAiProvider.streamAnswer 미구현 (docs/specs/13)');
  }
}
