/**
 * Anthropic Messages 스트리밍 어댑터 (docs/specs/13).
 * content_block_delta(text_delta)만 소비하고 message_stop에서 종료한다.
 */
import { AnthropicProviderConfig } from './llm.config';
import { LlmProvider, LlmProviderError, LlmStreamRequest } from './llm-provider.port';
import { buildPrompt } from './prompt-builder';
import { fetchStream, parseJson, toProviderError } from './provider-http';
import { parseSseFrames } from './sse-stream.parser';

const API_VERSION = '2023-06-01';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;

  constructor(private readonly config: AnthropicProviderConfig) {
    this.model = config.model;
  }

  async *streamAnswer(request: LlmStreamRequest): AsyncIterable<string> {
    request.signal?.throwIfAborted();

    const prompt = buildPrompt(request);
    const response = await fetchStream(
      `${this.config.baseUrl}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: this.config.model,
          stream: true,
          max_tokens: this.config.maxOutputTokens,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
        }),
      },
      this.name,
      request.signal,
    );

    if (!response.ok) throw await toProviderError(this.name, response);
    if (!response.body) {
      throw new LlmProviderError('anthropic 응답 본문이 비어 있습니다', { retryable: true });
    }

    for await (const frame of parseSseFrames(response.body)) {
      const payload = parseJson(frame.data);
      const type = typeof payload?.type === 'string' ? payload.type : frame.event;

      if (type === 'message_stop') return;
      if (type === 'error') {
        // 스트림 중간 오류 이벤트 — 일시 장애로 보고 상위 재시도·폴백에 맡긴다
        throw new LlmProviderError(`anthropic 스트림 오류: ${frame.data}`, { retryable: true });
      }
      if (type !== 'content_block_delta') continue;

      const delta = payload?.delta as { type?: unknown; text?: unknown } | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
        yield delta.text;
      }
    }
  }
}
