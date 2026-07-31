/**
 * Anthropic Messages 스트리밍 어댑터 (docs/specs/13).
 * content_block_delta(text_delta)만 소비하고 message_stop에서 종료한다.
 */
import { fetchStream, parseJson, toProviderError } from '../../http/provider-http';
import { parseSseFrames } from '../../http/sse-stream.parser';
import {
  LLM_FIRST_BYTE_TIMEOUT_MS,
  LlmProvider,
  LlmProviderError,
  LlmStreamRequest,
} from '../llm-provider.port';
import { buildPrompt } from '../prompt-builder';
import { AnthropicProviderConfig } from './llm.config';

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
    const http = {
      provider: this.name,
      errorClass: LlmProviderError,
      signal: request.signal,
      timeoutMs: LLM_FIRST_BYTE_TIMEOUT_MS,
    };
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
      http,
    );

    if (!response.ok) throw await toProviderError(response, http);
    if (!response.body) {
      throw new LlmProviderError('anthropic 응답 본문이 비어 있습니다', { retryable: true });
    }

    // usage는 두 프레임에 나뉘어 온다: input은 message_start, output 누계는 message_delta
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
        const payload = parseJson(frame.data);
        const type = typeof payload?.type === 'string' ? payload.type : frame.event;

        if (type === 'message_start') {
          const message = payload?.message as { usage?: unknown } | undefined;
          inputTokens = tokenCountOf(message?.usage, 'input_tokens') ?? inputTokens;
          continue;
        }
        if (type === 'message_delta') {
          // output_tokens는 누계로 갱신된다 — 마지막 값이 최종 소비량이다
          outputTokens = tokenCountOf(payload?.usage, 'output_tokens') ?? outputTokens;
          continue;
        }
        if (type === 'message_stop') return;
        if (type === 'error') {
          // 스트림 중간 오류 이벤트 — 일시 장애로 보고 상위 재시도·폴백에 맡긴다
          throw new LlmProviderError(`anthropic 스트림 오류: ${frame.data}`, { retryable: true });
        }
        if (type !== 'content_block_delta') continue;

        const delta = payload?.delta as { type?: unknown; text?: unknown } | undefined;
        if (
          delta?.type === 'text_delta' &&
          typeof delta.text === 'string' &&
          delta.text.length > 0
        ) {
          yield delta.text;
        }
      }
    } finally {
      // message_stop으로 끝나든 스트림이 그냥 닫히든 한 번은 보고한다
      reportUsage();
    }
  }
}

function tokenCountOf(usage: unknown, key: string): number | null {
  const value = (usage as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
