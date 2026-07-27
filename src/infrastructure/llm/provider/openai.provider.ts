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
          // 마지막 청크에 usage를 실어 보낸다 — 토큰 비용 지표(llm_tokens_total)의 원천
          stream_options: { include_usage: true },
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

    // usage는 choices가 빈 마지막 청크에 실려 온다 (stream_options.include_usage)
    let inputTokens = 0;
    let outputTokens = 0;
    let usageReported = false;
    const reportUsage = (): void => {
      if (usageReported) return;
      usageReported = true;
      request.onUsage?.({ inputTokens, outputTokens });
    };

    try {
      for await (const frame of parseSseFrames(response.body)) {
        if (frame.data === DONE_SENTINEL) return;

        const payload = parseJson(frame.data);
        if (!payload) continue;

        const usage = payload.usage as Record<string, unknown> | undefined;
        if (usage) {
          inputTokens = tokenCountOf(usage, 'prompt_tokens') ?? inputTokens;
          outputTokens = tokenCountOf(usage, 'completion_tokens') ?? outputTokens;
        }

        const delta = textDeltaOf(payload);
        if (delta) yield delta;
      }
    } finally {
      // [DONE]으로 끝나든 스트림이 그냥 닫히든 한 번은 보고한다
      reportUsage();
    }
  }
}

function textDeltaOf(payload: Record<string, unknown>): string | null {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const delta = (choices[0] as { delta?: { content?: unknown } }).delta;
  return typeof delta?.content === 'string' && delta.content.length > 0 ? delta.content : null;
}

function tokenCountOf(usage: Record<string, unknown>, key: string): number | null {
  const value = usage[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
