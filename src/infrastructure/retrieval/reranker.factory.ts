/**
 * 리랭커 등록 정책 (docs/specs/29) — embedding 팩토리 선례를 따른다:
 * OPENAI_API_KEY가 있으면 실물, 없으면 결정적 fake 단독이다 (e2e·로컬).
 */
import { FakeReranker } from './fake-reranker';
import { OpenAiReranker } from './openai-reranker';
import { Reranker } from './reranker.port';

export function createReranker(env: NodeJS.ProcessEnv): Reranker {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return new FakeReranker();
  return new OpenAiReranker({
    apiKey,
    model: env.OPENAI_MODEL?.trim() || 'gpt-5.4-mini',
    baseUrl: env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
  });
}
