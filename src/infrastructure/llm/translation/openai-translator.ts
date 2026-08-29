/**
 * OpenAI 단발 번역기 (docs/specs/42) — `OpenAiReranker` 구조를 따른다.
 *
 * 리랭커와 달리 **재시도를 태운다**: 폴백이 없어(기준 7) 일시 장애 한 번이 사용자의 질의를
 * 그대로 죽인다. `withRetry`는 게이트웨이에 묶이지 않은 독립 헬퍼라 그대로 쓰고, 그 판정이
 * `LlmProviderError`를 보므로 `TranslatorError`가 그것을 상속한다.
 *
 * 서킷브레이커·프로바이더 폴백은 붙이지 않는다 — 번역에는 폴백할 대상이 없고, 실패는 기준 7대로
 * 시끄럽게 끝나는 것이 옳다.
 */
import { fetchStream, parseJson, toProviderError } from '../../http/provider-http';
import { ProviderErrorOptions } from '../../http/provider-http';
import { LlmProviderError } from '../llm-provider.port';
import { withRetry } from '../resilience/retry-policy';
import { renderTermbase } from '../terminology';
import { SupportedLang, Translator } from './translator.port';

export interface OpenAiTranslatorConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/** `withRetry`가 `LlmProviderError`만 재시도하므로 상속한다 — 등급(`retryable`)은 그대로 소비된다 */
export class TranslatorError extends LlmProviderError {
  constructor(message: string, options: ProviderErrorOptions = {}) {
    super(message, options);
    this.name = 'TranslatorError';
  }
}

const TARGET_NAME: Record<SupportedLang, string> = {
  ko: '한국어',
  en: '영어(English)',
};

/**
 * 용어집을 실어 보낸다 — 답변 생성 프롬프트와 **같은 목록**이다. 두 산출물이 같은 용어를 달리
 * 쓰면 독자는 근거가 답을 지지하지 않는다고 읽는다 (docs/specs/42 판단표).
 */
function systemPromptFor(target: SupportedLang): string {
  return [
    `너는 한의 임상 문장을 ${TARGET_NAME[target]}로 번역한다.`,
    '임상적 의미와 구체성을 그대로 보존한다 — 처방명·혈자리·수치·기간을 바꾸거나 빠뜨리지 않는다.',
    '설명·주석·따옴표를 붙이지 말고 번역문만 출력한다.',
    '아래 용어는 반드시 이 대응으로 옮긴다:',
    renderTermbase(),
  ].join('\n');
}

export class OpenAiTranslator implements Translator {
  constructor(private readonly config: OpenAiTranslatorConfig) {}

  get model(): string {
    return this.config.model;
  }

  async translate(text: string, target: SupportedLang): Promise<string> {
    const context = { provider: 'openai-translator', errorClass: TranslatorError };

    return withRetry(async () => {
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
            messages: [
              { role: 'system', content: systemPromptFor(target) },
              { role: 'user', content: text },
            ],
          }),
        },
        context,
      );
      if (!response.ok) throw await toProviderError(response, context);

      const payload = parseJson(await response.text());
      const content = extractContent(payload).trim();
      // 빈 번역은 조용히 넘기면 원문 없는 검색·표시가 된다 — 폴백이 없으므로 던진다(기준 7)
      if (content.length === 0) throw new TranslatorError('번역 응답이 비어 있습니다');
      return content;
    });
  }
}

function extractContent(payload: Record<string, unknown> | null): string {
  const choices = payload?.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const message = (choices[0] as { message?: { content?: unknown } }).message;
    if (typeof message?.content === 'string') return message.content;
  }
  throw new TranslatorError('번역 응답에 본문이 없습니다');
}
