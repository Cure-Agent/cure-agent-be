/**
 * OpenAI Chat Completions 스트리밍 어댑터 (docs/specs/13).
 * 오류는 LlmProviderError로 등급화해 §11 4단 방어가 소비한다 — abort는 감싸지 않고 원 오류 전파.
 *
 * 답변가능성 게이트가 켜져 있으면 flag-first 구조화 출력을 요청하고 본문을 증분 파싱한다
 * (docs/specs/40). 꺼져 있으면 평문 델타를 그대로 흘리는 오늘의 경로다 — 그것이 롤백 상태다.
 */
import { fetchStream, parseJson, toProviderError } from '../../http/provider-http';
import { parseSseFrames } from '../../http/sse-stream.parser';
import {
  LLM_FIRST_BYTE_TIMEOUT_MS,
  LlmAnswerChunk,
  LlmProvider,
  LlmProviderError,
  LlmStreamRequest,
} from '../llm-provider.port';
import { buildPrompt } from '../prompt-builder';
import { OpenAiProviderConfig } from './llm.config';
import { ANSWER_RESPONSE_FORMAT, StructuredAnswerParser } from './structured-answer';

const DONE_SENTINEL = '[DONE]';

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  readonly model: string;

  constructor(private readonly config: OpenAiProviderConfig) {
    this.model = config.model;
  }

  async *streamAnswer(request: LlmStreamRequest): AsyncIterable<LlmAnswerChunk> {
    request.signal?.throwIfAborted();

    const prompt = buildPrompt(request);
    const http = {
      provider: this.name,
      errorClass: LlmProviderError,
      signal: request.signal,
      timeoutMs: LLM_FIRST_BYTE_TIMEOUT_MS,
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
          // 게이트가 꺼진 구성에서는 아예 싣지 않는다 — 요청 형태가 오늘과 같아야 롤백이다
          ...(this.config.answerabilityGate
            ? { response_format: ANSWER_RESPONSE_FORMAT }
            : {}),
          // 추론 모델 전용 인자 — 비추론 모델은 400으로 거부하므로 설정이 있을 때만 싣는다
          ...(this.config.reasoningEffort
            ? { reasoning_effort: this.config.reasoningEffort }
            : {}),
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

    const parser = this.config.answerabilityGate ? new StructuredAnswerParser() : null;

    try {
      for await (const frame of parseSseFrames(response.body)) {
        if (frame.data === DONE_SENTINEL) break;

        const payload = parseJson(frame.data);
        if (!payload) continue;

        const usage = payload.usage as Record<string, unknown> | undefined;
        if (usage) {
          inputTokens = tokenCountOf(usage, 'prompt_tokens') ?? inputTokens;
          outputTokens = tokenCountOf(usage, 'completion_tokens') ?? outputTokens;
        }

        const delta = textDeltaOf(payload);
        if (!delta) continue;
        if (!parser) {
          yield { kind: 'delta', text: delta };
          continue;
        }
        // 기권이 확정되면 파서가 이후 입력을 보지 않는다 — 프레임은 계속 읽어 usage만 받는다
        for (const chunk of parser.push(delta)) yield chunk;
      }
      if (parser) for (const chunk of parser.finish()) yield chunk;
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
