// docs/specs/14 수용 기준 5 동결 테스트 — 구현 중 수정 금지
import { createEmbeddingProvider } from './embedding-provider.factory';
import { FakeEmbeddingProvider } from './fake-embedding.provider';

describe('createEmbeddingProvider', () => {
  it('기준 5: OPENAI_API_KEY가 없으면 fake 임베딩 프로바이더를 등록한다', () => {
    const provider = createEmbeddingProvider(
      {} as NodeJS.ProcessEnv,
      new FakeEmbeddingProvider(),
    );

    expect(provider.model).toBe('fake-embedding-v1');
  });

  it('기준 5: OPENAI_API_KEY가 있으면 OpenAI 임베딩 프로바이더를 등록한다', () => {
    const provider = createEmbeddingProvider(
      { OPENAI_API_KEY: 'k' } as NodeJS.ProcessEnv,
      new FakeEmbeddingProvider(),
    );

    expect(provider.model).toBe('text-embedding-3-small');
  });
});
