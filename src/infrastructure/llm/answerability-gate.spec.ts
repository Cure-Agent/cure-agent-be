// docs/specs/40 수용 기준 16·18·24~26 동결 테스트 — 구현 중 수정 금지
import { MetricsService } from '../../global/observability/metrics/metrics.service';
import { RealTimeAlertSender } from '../../global/observability/real-time-alert.sender';
import { LlmGateway } from './llm-gateway';
import {
  LlmProviderError,
  type LlmAnswerChunk,
  type LlmProvider,
  type LlmStreamRequest,
} from './llm-provider.port';
import { resolveLlmConfig } from './provider/llm.config';
import { OpenAiProvider } from './provider/openai.provider';
import { CircuitBreaker } from './resilience/circuit-breaker';
import { RateLimitBlockStore } from './resilience/rate-limit-block-store';

const enabledConfig = {
  apiKey: 'test-key',
  model: 'test-model',
  baseUrl: 'https://api.test.local/v1',
  maxOutputTokens: 256,
  answerabilityGate: true,
};

const disabledConfig = {
  ...enabledConfig,
  answerabilityGate: false,
};

const llmRequest: LlmStreamRequest = {
  question: '만성 요통 환자에게 침 치료가 효과적인가요?',
  evidence: [
    {
      marker: 1,
      content: '만성 요통 환자에게 통증 감소를 위해 침 치료를 권고한다.',
      guidelineTitle: '요통 진료지침',
      sectionPath: ['치료', '침치료'],
    },
  ],
};

/** content 조각을 OpenAI 채팅 완료 SSE 프레임으로 감싼다. */
function openAiStreamResponse(
  contentParts: string[],
  includeDone = true,
): Response {
  const encoder = new TextEncoder();
  const frames = contentParts.map(
    (content) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
  );
  if (includeDone) frames.push('data: [DONE]\n\n');

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function collectChunks(
  iterable: AsyncIterable<LlmAnswerChunk>,
): Promise<LlmAnswerChunk[]> {
  const chunks: LlmAnswerChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

function sentBody(
  fetchMock: jest.SpyInstance,
  callIndex: number,
): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function buildGateway(providers: LlmProvider[]): LlmGateway {
  return new LlmGateway(
    providers,
    new CircuitBreaker(),
    new RateLimitBlockStore(),
    { send: jest.fn() } as unknown as RealTimeAlertSender,
    new MetricsService(),
  );
}

describe('spec 40: 답변가능성 게이트 프로바이더와 게이트웨이', () => {
  afterEach(() => jest.restoreAllMocks());

  it('기준 16: 게이트 off 요청에는 response_format이 없고 on 요청에는 json_schema가 있다', async () => {
    const structuredAnswer = JSON.stringify({
      insufficient_evidence: false,
      missing_aspects: [],
      answer: '침 치료를 권고합니다 [1].',
    });
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(openAiStreamResponse(['평문 답변 [1].']))
      .mockResolvedValueOnce(openAiStreamResponse([structuredAnswer]));

    await collectChunks(
      new OpenAiProvider(disabledConfig).streamAnswer(llmRequest),
    );
    await collectChunks(
      new OpenAiProvider(enabledConfig).streamAnswer(llmRequest),
    );

    expect(sentBody(fetchMock, 0)).not.toHaveProperty('response_format');
    expect(sentBody(fetchMock, 1)).toMatchObject({
      response_format: { type: 'json_schema' },
    });
  });

  it('기준 18: env 미지정·빈 값은 게이트를 켜고 false만 게이트를 끈다', () => {
    const unspecified = resolveLlmConfig({
      OPENAI_API_KEY: 'k',
    } as NodeJS.ProcessEnv);
    const empty = resolveLlmConfig({
      OPENAI_API_KEY: 'k',
      LLM_ANSWERABILITY_GATE_ENABLED: '',
    } as NodeJS.ProcessEnv);
    const disabled = resolveLlmConfig({
      OPENAI_API_KEY: 'k',
      LLM_ANSWERABILITY_GATE_ENABLED: 'false',
    } as NodeJS.ProcessEnv);

    expect(unspecified.openai?.answerabilityGate).toBe(true);
    expect(empty.openai?.answerabilityGate).toBe(true);
    expect(disabled.openai?.answerabilityGate).toBe(false);
  });

  it.each([
    ['JSON이 아닌 본문', ['구조화되지 않은 쓰레기'], true],
    ['플래그 앞에서 끊긴 본문', ['{"insufficient_evi'], false],
  ] as const)(
    '기준 24: 플래그 확정 전 %s은 LlmProviderError가 된다',
    async (_label, parts, includeDone) => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(openAiStreamResponse([...parts], includeDone));

      await expect(
        collectChunks(
          new OpenAiProvider(enabledConfig).streamAnswer(llmRequest),
        ),
      ).rejects.toBeInstanceOf(LlmProviderError);
    },
  );

  it('기준 25: 플래그 전 파싱 실패는 다음 프로바이더 답변으로 폴백한다', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      openAiStreamResponse(['{"missing_aspects":[]'], false),
    );
    const secondary: LlmProvider = {
      name: 'parser-fallback-secondary',
      model: 'secondary-model',
      async *streamAnswer(): AsyncIterable<LlmAnswerChunk> {
        yield { kind: 'delta', text: '두 번째 프로바이더 답변 [1].' };
      },
    };
    const gateway = buildGateway([
      new OpenAiProvider({ ...enabledConfig, model: 'primary-model' }),
      secondary,
    ]);
    const deltas: string[] = [];

    const outcome = await gateway.stream(llmRequest, (delta) => {
      deltas.push(delta);
    });

    expect(outcome.provider).toBe('parser-fallback-secondary');
    expect(outcome.text).toBe('두 번째 프로바이더 답변 [1].');
    expect(deltas).toEqual(['두 번째 프로바이더 답변 [1].']);
  });

  it('기준 25: verdict만 받은 시도가 죽어도 delta 전이므로 다음 프로바이더로 폴백한다', async () => {
    const verdictThenFailure: LlmProvider = {
      name: 'verdict-then-failure',
      async *streamAnswer(): AsyncIterable<LlmAnswerChunk> {
        yield {
          kind: 'verdict',
          insufficientEvidence: false,
          missingAspects: [],
        };
        throw new LlmProviderError('verdict 뒤 의도된 실패', {
          retryable: true,
        });
      },
    };
    const secondary: LlmProvider = {
      name: 'verdict-fallback-secondary',
      async *streamAnswer(): AsyncIterable<LlmAnswerChunk> {
        yield {
          kind: 'verdict',
          insufficientEvidence: false,
          missingAspects: [],
        };
        yield { kind: 'delta', text: '폴백으로 완성한 답변' };
      },
    };
    const gateway = buildGateway([verdictThenFailure, secondary]);
    const deltas: string[] = [];

    const outcome = await gateway.stream(llmRequest, (delta) => {
      deltas.push(delta);
    });

    expect(outcome.provider).toBe('verdict-fallback-secondary');
    expect(outcome.text).toBe('폴백으로 완성한 답변');
    expect(outcome.verdict).toEqual({
      insufficientEvidence: false,
      missingAspects: [],
    });
    expect(deltas).toEqual(['폴백으로 완성한 답변']);
  });

  it('기준 26: false 플래그 확정 뒤 잘린 본문은 지금까지의 델타로 예외 없이 끝난다', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      openAiStreamResponse(
        [
          '{"insufficient_evidence":false,"missing_aspects":[],"answer":"첫 번째 ',
          '델타',
        ],
        false,
      ),
    );

    const chunks = await collectChunks(
      new OpenAiProvider(enabledConfig).streamAnswer(llmRequest),
    );
    const verdicts = chunks.filter((chunk) => chunk.kind === 'verdict');
    const deltas = chunks
      .filter(
        (chunk): chunk is Extract<LlmAnswerChunk, { kind: 'delta' }> =>
          chunk.kind === 'delta',
      )
      .map((chunk) => chunk.text);

    expect(verdicts).toEqual([
      {
        kind: 'verdict',
        insufficientEvidence: false,
        missingAspects: [],
      },
    ]);
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.join('')).toBe('첫 번째 델타');
  });
});
