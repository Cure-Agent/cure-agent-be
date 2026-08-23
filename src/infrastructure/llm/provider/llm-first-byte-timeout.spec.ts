/**
 * 회귀: OpenAI·Anthropic은 첫 토큰이 준비되기 전에는 응답 헤더를 내보내지 않는다.
 * 추론 모델(gpt-5-mini)의 실측 TTFT가 약 9.5s여서, 기본 10s 상한으로는 실제 근거 프롬프트의
 * 매 요청이 타임아웃 → LLM_UNAVAILABLE로 떨어졌다. LLM 경로는 더 긴 예산을 써야 한다.
 */
import {
  LLM_FIRST_BYTE_TIMEOUT_MS,
  type LlmAnswerChunk,
  type LlmStreamRequest,
} from '../llm-provider.port';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiProvider } from './openai.provider';

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

/** 헤더가 ms 뒤에 도착하는 SSE 응답 — abort되면 abort 사유로 reject한다 */
function respondAfter(ms: number, frames: string): void {
  jest.spyOn(global, 'fetch').mockImplementation(
    (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason));
        setTimeout(() => resolve(new Response(frames, { status: 200 })), ms);
      }),
  );
}

async function collect(iterable: AsyncIterable<LlmAnswerChunk>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iterable) if (chunk.kind === 'delta') out.push(chunk.text);
  return out;
}

describe('LLM 첫 응답 타임아웃 예산', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('기본 10s를 넘겨 도착한 헤더도 예산 안이면 처리한다 (openai)', async () => {
    respondAfter(
      30_000,
      'data: {"choices":[{"delta":{"content":"침 치료는 권고됩니다 [1]."}}]}\n\ndata: [DONE]\n\n',
    );
    const provider = new OpenAiProvider({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://api.test.local/v1',
      maxOutputTokens: 256,
      // 이 스위트가 재는 것은 첫 응답 예산뿐이다 — 구조화 파싱은 여기 관심사가 아니다
      answerabilityGate: false,
    });

    const deltas = collect(provider.streamAnswer(request));
    await jest.advanceTimersByTimeAsync(30_000);

    await expect(deltas).resolves.toEqual(['침 치료는 권고됩니다 [1].']);
  });

  it('기본 10s를 넘겨 도착한 헤더도 예산 안이면 처리한다 (anthropic)', async () => {
    respondAfter(
      30_000,
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"침 치료는 권고됩니다 [1]."}}\n\n' +
        'data: {"type":"message_stop"}\n\n',
    );
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://api.test.local/v1',
      maxOutputTokens: 256,
    });

    const deltas = collect(provider.streamAnswer(request));
    await jest.advanceTimersByTimeAsync(30_000);

    await expect(deltas).resolves.toEqual(['침 치료는 권고됩니다 [1].']);
  });

  it('예산은 재시도 2회를 쓰고도 호출측 전체 상한 120s 안에 폴백 여지를 남긴다', () => {
    // retry-policy MAX_ATTEMPTS=2 · BACKOFF_MS=300 (§11-1) 기준
    expect(LLM_FIRST_BYTE_TIMEOUT_MS * 2 + 300).toBeLessThan(120_000);
    // 실측 TTFT(약 9.5s) 대비 충분한 여유
    expect(LLM_FIRST_BYTE_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});
