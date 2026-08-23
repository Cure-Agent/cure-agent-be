/**
 * reasoning_effort 전송 계약.
 * 추론 모델은 사고 시간이 곧 TTFT라 low로 낮추지만, 비추론 모델은 이 인자를
 * 400(Unrecognized request argument)으로 거부하므로 설정이 있을 때만 실어야 한다.
 */
import type { LlmAnswerChunk, LlmStreamRequest } from '../llm-provider.port';
import { resolveLlmConfig } from './llm.config';
import { OpenAiProvider } from './openai.provider';

// answerabilityGate=false — 이 스위트가 재는 것은 reasoning_effort 전송 계약뿐이다
const baseConfig = {
  apiKey: 'test-key',
  model: 'test-model',
  baseUrl: 'https://api.test.local/v1',
  maxOutputTokens: 256,
  answerabilityGate: false,
};

const request: LlmStreamRequest = {
  question: '만성 요통에 침 치료가 효과적인가요?',
  evidence: [
    {
      marker: 1,
      content: '만성 요통에 침 치료를 권고한다',
      guidelineTitle: '요통 진료지침',
      sectionPath: ['치료', '침치료'],
    },
  ],
};

function mockFetch(): jest.SpyInstance {
  return jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response('data: [DONE]\n\n', { status: 200 }));
}

async function drain(iterable: AsyncIterable<LlmAnswerChunk>): Promise<void> {
  for await (const _chunk of iterable) void _chunk;
}

function sentBody(fetchMock: jest.SpyInstance): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('OpenAiProvider reasoning_effort', () => {
  afterEach(() => jest.restoreAllMocks());

  it('설정이 있으면 요청 본문에 싣는다', async () => {
    const fetchMock = mockFetch();

    await drain(
      new OpenAiProvider({ ...baseConfig, reasoningEffort: 'low' }).streamAnswer(request),
    );

    expect(sentBody(fetchMock)).toMatchObject({ reasoning_effort: 'low' });
  });

  it.each([['null', null], ['undefined', undefined]])(
    '설정이 %s면 본문에서 생략한다 (비추론 모델 호환)',
    async (_label, effort) => {
      const fetchMock = mockFetch();

      await drain(
        new OpenAiProvider({ ...baseConfig, reasoningEffort: effort }).streamAnswer(request),
      );

      expect(sentBody(fetchMock)).not.toHaveProperty('reasoning_effort');
    },
  );
});

describe('resolveLlmConfig reasoningEffort', () => {
  it('미지정이면 기본 모델(gpt-5.4-mini)에 맞춰 미전송이다', () => {
    const config = resolveLlmConfig({ OPENAI_API_KEY: 'k' } as NodeJS.ProcessEnv);

    expect(config.openai?.model).toBe('gpt-5.4-mini');
    // 기본 강도로도 충분히 빨라 강도를 낮출 이유가 없다
    expect(config.openai?.reasoningEffort).toBeNull();
  });

  it('none이면 null로 꺼서 비추론 모델을 쓸 수 있게 한다', () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: 'k',
      OPENAI_MODEL: 'gpt-4.1-mini',
      OPENAI_REASONING_EFFORT: 'none',
    } as NodeJS.ProcessEnv);

    expect(config.openai?.reasoningEffort).toBeNull();
  });

  it('compose가 빈 값으로 통과시켜도 코드 기본값으로 떨어진다', () => {
    // docker/gcp/compose.yml이 `${VAR:-}`로 넘긴다 — 여기에 기본값을 중복해두면
    // 코드가 올라가도 컨테이너는 옛 값을 받는다(LLM_MAX_OUTPUT_TOKENS 1024 사고).
    const config = resolveLlmConfig({
      OPENAI_API_KEY: 'k',
      OPENAI_MODEL: '',
      OPENAI_REASONING_EFFORT: '',
      LLM_MAX_OUTPUT_TOKENS: '',
    } as NodeJS.ProcessEnv);

    expect(config.openai?.model).toBe('gpt-5.4-mini');
    expect(config.openai?.reasoningEffort).toBeNull();
    expect(config.openai?.maxOutputTokens).toBe(4096);
  });

  it('느린 추론 모델로 되돌릴 때는 강도를 낮출 수 있다', () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: 'k',
      OPENAI_MODEL: 'gpt-5-mini',
      OPENAI_REASONING_EFFORT: 'low',
    } as NodeJS.ProcessEnv);

    expect(config.openai?.reasoningEffort).toBe('low');
  });

  it('지정한 강도를 그대로 전달한다', () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: 'k',
      OPENAI_REASONING_EFFORT: 'high',
    } as NodeJS.ProcessEnv);

    expect(config.openai?.reasoningEffort).toBe('high');
  });
});
