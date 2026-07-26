/**
 * OpenAI Chat Completions 스트리밍 어댑터 (docs/specs/13).
 * 오류는 LlmProviderError로 등급화해 §11 4단 방어가 소비한다 — abort는 감싸지 않고 원 오류 전파.
 */
import { fetchStream, parseJson, toProviderError } from '../../http/provider-http';
import { parseSseFrames } from '../../http/sse-stream.parser';
import { LlmProvider, LlmProviderError, LlmStreamRequest } from '../llm-provider.port';
import { buildPrompt } from '../prompt-builder';
import { OpenAiProviderConfig } from './llm.config';

const DONE_SENTINEL = '[DONE]';

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  readonly model: string;

  constructor(private readonly config: OpenAiProviderConfig) {
    this.model = config.model;
  }

  async *streamAnswer(request: LlmStreamRequest): AsyncIterable<string> {
    request.signal?.throwIfAborted();

    const prompt = buildPrompt(request);
    const http = {
      provider: this.name,
      errorClass: LlmProviderError,
      signal: request.signal,
    };
    const response = await fetchStream(
      `${this.config.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          stream: true,
          max_completion_tokens: this.config.maxOutputTokens,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        }),
      },
      http,
    );

    if (!response.ok) throw await toProviderError(response, http);
    if (!response.body) {
      throw new LlmProviderError('openai 응답 본문이 비어 있습니다', { retryable: true });
    }

    for await (const frame of parseSseFrames(response.body)) {
      if (frame.data === DONE_SENTINEL) return;

      const delta = textDeltaOf(frame.data);
      if (delta) yield delta;
    }
  }
}

function textDeltaOf(data: string): string | null {
  const payload = parseJson(data);
  if (!payload) return null;

  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const delta = (choices[0] as { delta?: { content?: unknown } }).delta;
  return typeof delta?.content === 'string' && delta.content.length > 0 ? delta.content : null;
}
