// docs/specs/14 수용 기준 1·2·3·4 동결 테스트 — 구현 중 수정 금지
import { EmbeddingProviderError } from './embedding-provider.port';
import { OpenAiEmbeddingProvider } from './openai-embedding.provider';

const DIMENSIONS = 1536;

const config = {
  apiKey: 'test-key',
  model: 'test-embedding-model',
  baseUrl: 'https://api.test.local/v1',
};

const vectorFor = (seed: number): number[] => [
  seed,
  ...Array<number>(DIMENSIONS - 1).fill(0),
];

const embeddingResponse = (
  items: { index: number; embedding: number[] }[],
): Response =>
  new Response(
    JSON.stringify({
      object: 'list',
      data: items.map((i) => ({ object: 'embedding', ...i })),
    }),
    { status: 200 },
  );

describe('OpenAiEmbeddingProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('기준 1: Embeddings API 계약으로 호출하고 뒤섞인 응답을 입력 순서로 반환한다', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      embeddingResponse([
        { index: 1, embedding: vectorFor(1) },
        { index: 0, embedding: vectorFor(0) },
      ]),
    );
    const provider = new OpenAiEmbeddingProvider(config);
    const input = ['첫 문장', '둘째 문장'];

    const result = await provider.embed(input);

    expect(result).toEqual([vectorFor(0), vectorFor(1)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test.local/v1/embeddings');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer test-key',
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'test-embedding-model',
      input,
      dimensions: DIMENSIONS,
    });
  });

  it('기준 2: 입력 100개를 96개와 4개로 나눠 호출하고 전체 입력 순서를 보존한다', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        const firstSeed = Number(body.input[0].replace('문장 ', ''));
        return embeddingResponse(
          body.input.map((_, index) => ({
            index,
            embedding: vectorFor(firstSeed + index),
          })),
        );
      });
    const provider = new OpenAiEmbeddingProvider(config);
    const input = Array.from({ length: 100 }, (_, i) => `문장 ${i}`);

    const result = await provider.embed(input);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(([, init]) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        return body.input.length;
      }),
    ).toEqual([96, 4]);
    expect(result).toHaveLength(100);
    result.forEach((vector, index) => {
      expect(vector[0]).toBe(index);
    });
  });

  it('기준 3: 429와 Retry-After 헤더를 rate limit 오류로 매핑한다', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"rate limited"}}', {
        status: 429,
        headers: { 'Retry-After': '30' },
      }),
    );
    const provider = new OpenAiEmbeddingProvider(config);
    let caught: unknown;

    try {
      await provider.embed(['첫 문장']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EmbeddingProviderError);
    expect((caught as EmbeddingProviderError).options.rateLimited).toBe(true);
    expect((caught as EmbeddingProviderError).options.retryAfterSec).toBe(30);
  });

  it('기준 3: 500을 retryable EmbeddingProviderError로 매핑한다', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"server error"}}', { status: 500 }),
    );
    const provider = new OpenAiEmbeddingProvider(config);
    let caught: unknown;

    try {
      await provider.embed(['첫 문장']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EmbeddingProviderError);
    expect((caught as EmbeddingProviderError).options.retryable).toBe(true);
  });

  it('기준 3: 401을 retryable하지 않은 EmbeddingProviderError로 매핑한다', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"unauthorized"}}', { status: 401 }),
    );
    const provider = new OpenAiEmbeddingProvider(config);
    let caught: unknown;

    try {
      await provider.embed(['첫 문장']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EmbeddingProviderError);
    expect((caught as EmbeddingProviderError).options.retryable).toBe(false);
  });

  it('기준 4: 응답 벡터 길이가 1536이 아니면 EmbeddingProviderError를 던진다', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      embeddingResponse([{ index: 0, embedding: [0, 1] }]),
    );
    const provider = new OpenAiEmbeddingProvider(config);
    let caught: unknown;

    try {
      await provider.embed(['첫 문장']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EmbeddingProviderError);
    expect((caught as EmbeddingProviderError).name).toBe(
      'EmbeddingProviderError',
    );
  });
});
