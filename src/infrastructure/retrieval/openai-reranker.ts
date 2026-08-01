/**
 * OpenAI 리스트와이즈 리랭커 (docs/specs/29).
 * 후보 30개(발췌 300자)를 한 번에 주고 상위 5개 + top-1 관련도(0~10)를 JSON으로 받는다 —
 * 실측(2026-08-01, 74문항)에서 이 구성이 Recall@5 0.983·파싱 실패 0건이었다.
 *
 * 오류는 전부 예외로 던진다 — 4단 방어(§11)를 태우지 않는 이유는 폴백이 재시도보다 싸고
 * 빠르기 때문이다: 호출측(conversation-stream)이 즉시 코사인 순위로 진행한다(기준 6).
 */
import { fetchStream, parseJson, toProviderError } from '../http/provider-http';
import { ProviderErrorOptions } from '../http/provider-http';
import { RerankCandidate, Reranker, RerankResult } from './reranker.port';

export interface OpenAiRerankerConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/** provider-http 오류 등급화가 요구하는 형태 — 리랭커는 폴백뿐이라 등급을 소비하지 않는다 */
export class RerankerError extends Error {
  constructor(
    message: string,
    readonly options: ProviderErrorOptions = {},
  ) {
    super(message);
    this.name = 'RerankerError';
  }
}

/** 후보 발췌 길이 — 실측에 쓴 값. 전문을 실으면 입력이 부풀고, 300자로 상한에 도달했다 */
const EXCERPT_LENGTH = 300;

const SYSTEM_PROMPT = [
  '당신은 한의 임상 지침 검색 결과를 재정렬하는 리랭커입니다.',
  '질문과 후보 근거 목록이 주어집니다. 질문에 실제로 답하는 근거인지로 판정하세요 —',
  '어휘가 겹쳐도 다른 질환·다른 주제면 관련이 없습니다.',
  'JSON만 출력: {"ranking":[가장 관련 있는 후보 번호 5개, 관련도 순],"top1Relevance":0~10 정수}',
  'top1Relevance는 1위 후보가 질문에 답하는 정도입니다 (0=무관, 10=직접 답변).',
].join('\n');

export class OpenAiReranker implements Reranker {
  constructor(private readonly config: OpenAiRerankerConfig) {}

  get model(): string {
    return this.config.model;
  }

  async rerank(question: string, candidates: RerankCandidate[]): Promise<RerankResult> {
    const list = candidates
      .map(
        (candidate, index) =>
          `[${index + 1}] (${candidate.guidelineTitle}) ${candidate.content.slice(0, EXCERPT_LENGTH)}`,
      )
      .join('\n');

    const context = { provider: 'openai-reranker', errorClass: RerankerError };
    const response = await fetchStream(
      `${this.config.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `질문: ${question}\n\n후보:\n${list}` },
          ],
        }),
      },
      context,
    );
    if (!response.ok) throw await toProviderError(response, context);

    const payload = parseJson(await response.text());
    const content = extractContent(payload);
    const parsed = parseJson(content);
    if (!parsed) throw new RerankerError('리랭커 응답이 JSON이 아닙니다');

    const ranking = Array.isArray(parsed.ranking) ? parsed.ranking : [];
    const order = ranking
      .filter(
        (n): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= candidates.length,
      )
      .map((n) => candidates[n - 1].chunkId);
    if (order.length === 0) throw new RerankerError('리랭커 응답에 유효한 순위가 없습니다');

    const relevance = Number(parsed.top1Relevance);
    if (!Number.isFinite(relevance)) {
      throw new RerankerError('리랭커 응답에 top1Relevance가 없습니다');
    }

    return { order, top1Relevance: relevance };
  }
}

function extractContent(payload: Record<string, unknown> | null): string {
  const choices = payload?.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const message = (choices[0] as { message?: { content?: unknown } }).message;
    if (typeof message?.content === 'string') return message.content;
  }
  throw new RerankerError('리랭커 응답에 본문이 없습니다');
}
