// docs/specs/13 수용 기준 5 동결 테스트 — 구현 중 수정 금지
import { AnthropicProvider } from './anthropic.provider';
import {
  LlmProviderError,
  type LlmStreamRequest,
} from './llm-provider.port';

const config = {
  apiKey: 'test-key',
  model: 'test-model',
  baseUrl: 'https://api.test.local/v1',
  maxOutputTokens: 256,
};

const request: LlmStreamRequest = {
  question: '만성 요통 치료는 어떻게 하나요?',
  evidence: [
    {
      marker: 1,
      content: '만성 요통에 침 치료를 권고한다',
      guidelineTitle: '요통 진료지침',
      sectionPath: ['치료', '침치료'],
    },
    {
      marker: 2,
      content: '급성기에는 물리치료를 병행한다',
      guidelineTitle: '요통 진료지침',
      sectionPath: ['치료', '물리치료'],
    },
  ],
};

function streamResponse(chunks: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const delta of iterable) out.push(delta);
  return out;
}

describe('AnthropicProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('text_delta만 순서대로 yield하고 message_stop에서 종료한다', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      streamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
        'event: ping\ndata: {"type":"ping"}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_',
        'delta","text":"침 치료는 "}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"권고됩니다 [1]."}}\n\nevent: message_',
        'stop\ndata: {"type":"message_stop"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"무시"}}\n\n',
      ]),
    );
    const provider = new AnthropicProvider(config);

    const deltas = await collect(provider.streamAnswer(request));

    expect(deltas).toEqual(['침 치료는 ', '권고됩니다 [1].']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(url).toBe('https://api.test.local/v1/messages');
    expect(headers.get('x-api-key')).toBe('test-key');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(JSON.parse(String(init?.body))).toEqual(
      expect.objectContaining({ stream: true }),
    );
  });

  it('429와 Retry-After 헤더를 rate limit 오류로 매핑한다', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"rate limited"}}', {
        status: 429,
        headers: { 'Retry-After': '30' },
      }),
    );
    const provider = new AnthropicProvider(config);
    let caught: unknown;

    try {
      await collect(provider.streamAnswer(request));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmProviderError);
    expect((caught as LlmProviderError).options.rateLimited).toBe(true);
    expect((caught as LlmProviderError).options.retryAfterSec).toBe(30);
  });

  it('Retry-After 헤더가 없는 429는 retryAfterSec 없이 매핑한다', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"rate limited"}}', { status: 429 }),
    );
    const provider = new AnthropicProvider(config);
    let caught: unknown;

    try {
      await collect(provider.streamAnswer(request));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmProviderError);
    expect((caught as LlmProviderError).options.rateLimited).toBe(true);
    expect((caught as LlmProviderError).options.retryAfterSec).toBeUndefined();
  });

  it('5xx를 retryable LlmProviderError로 매핑한다', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"server error"}}', { status: 500 }),
    );
    const provider = new AnthropicProvider(config);
    let caught: unknown;

    try {
      await collect(provider.streamAnswer(request));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmProviderError);
    expect((caught as LlmProviderError).options.retryable).toBe(true);
  });

  it('4xx를 retryable하지 않은 LlmProviderError로 매핑한다', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"unauthorized"}}', { status: 401 }),
    );
    const provider = new AnthropicProvider(config);
    let caught: unknown;

    try {
      await collect(provider.streamAnswer(request));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmProviderError);
    expect((caught as LlmProviderError).options.retryable).toBe(false);
  });
});
