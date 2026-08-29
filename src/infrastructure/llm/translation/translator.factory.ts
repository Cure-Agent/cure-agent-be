/**
 * 번역기 등록 정책 (docs/specs/42) — reranker·embedding 팩토리 선례를 따른다:
 * OPENAI_API_KEY가 있으면 실물, 없으면 결정적 fake 단독이다 (e2e·로컬).
 */
import { FakeTranslator } from './fake-translator';
import { OpenAiTranslator } from './openai-translator';
import { Translator } from './translator.port';

export function createTranslator(env: NodeJS.ProcessEnv): Translator {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return new FakeTranslator();
  return new OpenAiTranslator({
    apiKey,
    model: env.OPENAI_MODEL?.trim() || 'gpt-5.4-mini',
    baseUrl: env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
  });
}
