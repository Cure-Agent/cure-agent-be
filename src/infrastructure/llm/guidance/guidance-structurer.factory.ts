/**
 * 구조화기 등록 정책 (docs/specs/33) — 리랭커 팩토리 선례를 따른다:
 * OPENAI_API_KEY가 있으면 실물, 없으면 결정적 fake 단독이다 (e2e·로컬).
 */
import { FakeGuidanceStructurer } from './fake-guidance-structurer';
import { GuidanceStructurer } from './guidance-structurer.port';
import { OpenAiGuidanceStructurer } from './openai-guidance-structurer';

export function createGuidanceStructurer(env: NodeJS.ProcessEnv): GuidanceStructurer {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return new FakeGuidanceStructurer();
  return new OpenAiGuidanceStructurer({
    apiKey,
    model: env.OPENAI_MODEL?.trim() || 'gpt-5.4-mini',
    baseUrl: env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
  });
}
