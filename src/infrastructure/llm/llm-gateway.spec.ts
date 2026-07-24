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
