import { RealTimeAlertSender } from '../../global/observability/real-time-alert.sender';
import { CircuitBreaker } from './circuit-breaker';
import { LlmExhaustedError, LlmGateway } from './llm-gateway';
import { LlmProvider } from './llm-provider.port';
import { RateLimitBlockStore } from './rate-limit-block-store';

const CIRCUIT_FAILURE_THRESHOLD = 5;

function failingProvider(name: string): LlmProvider {
  return {
    name,
    async *streamAnswer(): AsyncIterable<string> {
      throw new Error('provider down');
    },
  };
}

describe('LlmGateway 실시간 알림 (docs/specs/12 기준 1·2)', () => {
  let sender: { send: jest.Mock };
  let breaker: CircuitBreaker;

  const buildGateway = (providers: LlmProvider[]): LlmGateway => {
    sender = { send: jest.fn() };
    breaker = new CircuitBreaker();
    return new LlmGateway(
      providers,
      breaker,
      new RateLimitBlockStore(),
      sender as unknown as RealTimeAlertSender,
    );
  };

  it('기준 1: 전 프로바이더 소진 시 LLM_EXHAUSTED 알림 후 LlmExhaustedError를 전파한다', async () => {
    const gateway = buildGateway([failingProvider('primary'), failingProvider('secondary')]);

    await expect(gateway.stream({ question: 'q', evidence: [] }, () => {})).rejects.toBeInstanceOf(
      LlmExhaustedError,
    );

    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'LLM_EXHAUSTED' }),
    );
  });

  it('기준 2: 연속 실패 임계 도달로 서킷 open 전이 시에만 LLM_CIRCUIT_OPEN을 1회 알린다', async () => {
    const gateway = buildGateway([failingProvider('primary')]);

    for (let attempt = 1; attempt <= CIRCUIT_FAILURE_THRESHOLD; attempt += 1) {
      await expect(gateway.stream({ question: 'q', evidence: [] }, () => {})).rejects.toThrow();

      const circuitOpenAlerts = sender.send.mock.calls.filter(
        ([event]: [{ title: string }]) => event.title === 'LLM_CIRCUIT_OPEN',
      );
      // 임계(5회) 미만에서는 open 알림이 없어야 하고, 도달 시 정확히 1회여야 한다
      expect(circuitOpenAlerts).toHaveLength(attempt < CIRCUIT_FAILURE_THRESHOLD ? 0 : 1);
    }
  });

  it('기준 2: 클라이언트 abort는 실패 기록·알림 없이 즉시 전파한다', async () => {
    const abortController = new AbortController();
    const abortingProvider: LlmProvider = {
      name: 'aborting',
      // eslint-disable-next-line require-yield
      async *streamAnswer(): AsyncIterable<string> {
        abortController.abort();
        throw new Error('aborted mid-stream');
      },
    };
    const gateway = buildGateway([abortingProvider]);

    await expect(
      gateway.stream({ question: 'q', evidence: [], signal: abortController.signal }, () => {}),
    ).rejects.toThrow('aborted mid-stream');

    expect(sender.send).not.toHaveBeenCalled();
    expect(breaker.isOpen('aborting')).toBe(false);
  });
});

describe('LlmGateway 모델 기록 (docs/specs/13 기준 8)', () => {
  const buildGateway = (providers: LlmProvider[]): LlmGateway =>
    new LlmGateway(
      providers,
      new CircuitBreaker(),
      new RateLimitBlockStore(),
      { send: jest.fn() } as unknown as RealTimeAlertSender,
    );

  const request = {
    question: '만성 요통 치료는 어떻게 하나요?',
    evidence: [
      {
        marker: 1,
        content: '만성 요통에 침 치료를 권고한다',
        guidelineTitle: '요통 진료지침',
        sectionPath: ['치료', '침치료'],
      },
    ],
  };

  it('model을 가진 프로바이더로 스트림 성공 시 outcome.model에 해당 모델을 기록한다', async () => {
    const provider: LlmProvider = {
      name: 'modeled-provider',
      model: 'model-v1',
      async *streamAnswer(): AsyncIterable<string> {
        yield '답변';
      },
    };
    const gateway = buildGateway([provider]);

    const outcome = await gateway.stream(request, () => undefined);

    expect(outcome.model).toBe('model-v1');
  });

  it('model이 없는 프로바이더로 스트림 성공 시 outcome.model은 undefined이고 provider 이름을 기록한다', async () => {
    const provider: LlmProvider = {
      name: 'unmodeled-provider',
      async *streamAnswer(): AsyncIterable<string> {
        yield '답변';
      },
    };
    const gateway = buildGateway([provider]);

    const outcome = await gateway.stream(request, () => undefined);

    expect(outcome.model).toBeUndefined();
    expect(outcome.provider).toBe('unmodeled-provider');
  });
});
