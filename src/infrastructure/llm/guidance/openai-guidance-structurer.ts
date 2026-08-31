/**
 * OpenAI 참고안 구조화기 (docs/specs/33) — 리랭커(docs/specs/29)와 같은 단발 json_object 호출.
 *
 * 오류는 전부 예외로 던진다 — 4단 방어(§11)를 태우지 않는 이유도 리랭커와 같다:
 * 호출측이 즉시 결정적 조립으로 폴백하는 편이 재시도보다 싸고 빠르다.
 */
import { ProviderErrorOptions, fetchStream, parseJson, toProviderError } from '../../http/provider-http';
import { buildGuidanceUserPrompt, guidanceSystemPromptFor } from './guidance-prompt';
import {
  GuidanceStructureRequest,
  GuidanceStructureResult,
  GuidanceStructurer,
  StructuredConsideration,
} from './guidance-structurer.port';

export interface OpenAiGuidanceStructurerConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/**
 * 첫 응답 상한. 호출 전체 상한(20s, structure-runner)보다 짧게 둬서 HTTP 단이 먼저 풀리고,
 * 바깥 상한은 마지막 경계로만 남게 한다 — 기본 10s는 추론 모델의 사고 시간에 짧다(§11-1).
 */
const FIRST_BYTE_TIMEOUT_MS = 18_000;

/** provider-http 오류 등급화가 요구하는 형태 — 구조화는 폴백뿐이라 등급을 소비하지 않는다 */
export class GuidanceStructurerError extends Error {
  constructor(
    message: string,
    readonly options: ProviderErrorOptions = {},
  ) {
    super(message);
    this.name = 'GuidanceStructurerError';
  }
}

export class OpenAiGuidanceStructurer implements GuidanceStructurer {
  constructor(private readonly config: OpenAiGuidanceStructurerConfig) {}

  get model(): string {
    return this.config.model;
  }

  async structure(request: GuidanceStructureRequest): Promise<GuidanceStructureResult> {
    const context = {
      provider: 'openai-guidance-structurer',
      errorClass: GuidanceStructurerError,
      signal: request.signal,
      timeoutMs: FIRST_BYTE_TIMEOUT_MS,
    };

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
            { role: 'system', content: guidanceSystemPromptFor(request.lang) },
            { role: 'user', content: buildGuidanceUserPrompt(request) },
          ],
        }),
      },
      context,
    );
    if (!response.ok) throw await toProviderError(response, context);

    const payload = parseJson(await response.text());
    const parsed = parseJson(extractContent(payload));
    if (!parsed) throw new GuidanceStructurerError('구조화 응답이 JSON이 아닙니다');

    return { considerations: normalizeConsiderations(parsed.considerations) };
  }
}

/**
 * 응답 정규화 — 관대하게 받는다. 모델이 마커를 문자열("3")로 내는 것은 리랭커에서 이미 실측됐고
 * (docs/specs/29), 여기서 잘못 걸러도 최악이 결정적 폴백이다. 진짜 판정은 도메인 검증기가 한다.
 */
export function normalizeConsiderations(value: unknown): StructuredConsideration[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const item = entry as Record<string, unknown>;
    return [
      {
        title: asString(item.title),
        rationale: asString(item.rationale),
        applicability: asString(item.applicability),
        markers: asMarkers(item.markers),
        patientFactors: asStringArray(item.patientFactors),
      },
    ];
  });
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function asMarkers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const markers: number[] = [];
  for (const entry of value) {
    const marker = Number(entry);
    if (Number.isInteger(marker)) markers.push(marker);
  }
  return markers;
}

function extractContent(payload: Record<string, unknown> | null): string {
  const choices = payload?.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const message = (choices[0] as { message?: { content?: unknown } }).message;
    if (typeof message?.content === 'string') return message.content;
  }
  throw new GuidanceStructurerError('구조화 응답에 본문이 없습니다');
}
