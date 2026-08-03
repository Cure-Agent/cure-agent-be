/**
 * OpenAI 참고안 구조화기 (docs/specs/33) — 리랭커(docs/specs/29)와 같은 단발 json_object 호출.
 *
 * 오류는 전부 예외로 던진다 — 4단 방어(§11)를 태우지 않는 이유도 리랭커와 같다:
 * 호출측이 즉시 결정적 조립으로 폴백하는 편이 재시도보다 싸고 빠르다.
 */
import { ProviderErrorOptions } from '../../http/provider-http';
import {
  GuidanceStructureRequest,
  GuidanceStructureResult,
  GuidanceStructurer,
} from './guidance-structurer.port';

export interface OpenAiGuidanceStructurerConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

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

  structure(_request: GuidanceStructureRequest): Promise<GuidanceStructureResult> {
    throw new Error('not implemented');
  }
}
