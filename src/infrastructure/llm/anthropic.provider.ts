/**
 * Anthropic Messages 스트리밍 어댑터 (docs/specs/13).
 * content_block_delta(text_delta)만 소비하고 message_stop에서 종료한다.
 */
import { AnthropicProviderConfig } from './llm.config';
import { LlmProvider, LlmStreamRequest } from './llm-provider.port';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;

  constructor(private readonly config: AnthropicProviderConfig) {
    this.model = config.model;
  }

  async *streamAnswer(_request: LlmStreamRequest): AsyncIterable<string> {
    throw new Error('AnthropicProvider.streamAnswer 미구현 (docs/specs/13)');
  }
}
