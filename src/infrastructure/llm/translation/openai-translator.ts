/**
 * OpenAI 단발 번역기 (docs/specs/42) — `OpenAiReranker` 구조를 따른다.
 *
 * 리랭커와 달리 재시도를 태운다: 폴백이 없어(기준 7) 일시 장애 한 번이 사용자의 질의를
 * 그대로 죽인다. `withRetry`는 게이트웨이에 묶이지 않은 독립 헬퍼라 그대로 쓴다.
 *
 * **스텁** — 구현은 docs/specs/42 수용 기준을 통과시키며 채운다.
 */
import { ProviderErrorOptions } from '../../http/provider-http';
import { SupportedLang, Translator } from './translator.port';

export interface OpenAiTranslatorConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/** provider-http 오류 등급화가 요구하는 형태 — 재시도 판정(`retryable`)이 이 등급을 소비한다 */
export class TranslatorError extends Error {
  constructor(
    message: string,
    readonly options: ProviderErrorOptions = {},
  ) {
    super(message);
    this.name = 'TranslatorError';
  }
}

export class OpenAiTranslator implements Translator {
  constructor(private readonly config: OpenAiTranslatorConfig) {}

  get model(): string {
    return this.config.model;
  }

  translate(_text: string, _target: SupportedLang): Promise<string> {
    throw new TranslatorError('not implemented');
  }
}
