// docs/specs/13 수용 기준 7 동결 테스트 — 구현 중 수정 금지
import { FakeLlmProvider } from './fake-llm.provider';
import { createLlmProviders } from './llm-providers.factory';

describe('createLlmProviders', () => {
  it('API 키가 없으면 fake-llm만 등록한다', () => {
    const fake = new FakeLlmProvider();

    const providers = createLlmProviders({} as NodeJS.ProcessEnv, fake);

    expect(providers.map((provider) => provider.name)).toEqual(['fake-llm']);
  });

  it('OPENAI_API_KEY만 있으면 fake 없이 openai만 등록한다', () => {
    const fake = new FakeLlmProvider();

    const providers = createLlmProviders(
      { OPENAI_API_KEY: 'openai-key' } as NodeJS.ProcessEnv,
      fake,
    );

    expect(providers.map((provider) => provider.name)).toEqual(['openai']);
  });

  it('두 API 키가 모두 있으면 openai, anthropic 순서로 등록한다', () => {
    const fake = new FakeLlmProvider();

    const providers = createLlmProviders(
      {
        OPENAI_API_KEY: 'openai-key',
        ANTHROPIC_API_KEY: 'anthropic-key',
      } as NodeJS.ProcessEnv,
      fake,
    );

    expect(providers.map((provider) => provider.name)).toEqual([
      'openai',
      'anthropic',
    ]);
  });
});
