// docs/specs/13 수용 기준 1·2·3·4 동결 테스트 — 구현 중 수정 금지
import {
  LlmProviderError,
  type LlmStreamRequest,
} from './llm-provider.port';
import { OpenAiProvider } from './openai.provider';

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

describe('OpenAiProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('청크 경계로 분할된 SSE delta를 순서대로 yield하고 [DONE]에서 종료한다', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      streamResponse([
        'data: {"choices":[{"delta":{"con',
        'tent":"침 치료는 "}}]}\n',
        '\ndata: {"choices":[{"delta":{"content":"권고됩',
        '니다 [1]."}}]}\n\ndata: [DO',
        'NE]\n\n',
      ]),
    );
    const provider = new OpenAiProvider(config);

    const deltas = await collect(provider.streamAnswer(request));

    expect(deltas).toEqual(['침 치료는 ', '권고됩니다 [1].']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test.local/v1/chat/completions');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer test-key',
    );
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
    const provider = new OpenAiProvider(config);
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
    const provider = new OpenAiProvider(config);
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

  it('500을 retryable LlmProviderError로 매핑한다', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"server error"}}', { status: 500 }),
    );
    const provider = new OpenAiProvider(config);
    let caught: unknown;

    try {
      await collect(provider.streamAnswer(request));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmProviderError);
    expect((caught as LlmProviderError).options.retryable).toBe(true);
  });

  it('401을 retryable하지 않은 LlmProviderError로 매핑한다', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"unauthorized"}}', { status: 401 }),
    );
    const provider = new OpenAiProvider(config);
    let caught: unknown;

    try {
      await collect(provider.streamAnswer(request));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmProviderError);
    expect((caught as LlmProviderError).options.retryable).toBe(false);
  });

  it('이미 abort된 signal이면 fetch와 yield 없이 원 오류를 전파한다', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('fetch should not be called'));
    const abortController = new AbortController();
    const abortReason = new Error('caller aborted');
    abortController.abort(abortReason);
    const provider = new OpenAiProvider(config);
    const deltas: string[] = [];
    let caught: unknown;

    try {
      for await (const delta of provider.streamAnswer({
        ...request,
        signal: abortController.signal,
      })) {
        deltas.push(delta);
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(abortReason);
    expect(caught).not.toBeInstanceOf(LlmProviderError);
    expect(deltas).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
