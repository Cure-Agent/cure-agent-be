/**
 * 심판 등록 정책 (docs/specs/30) — 리랭커 팩토리(docs/specs/29) 선례를 따른다:
 * OPENAI_API_KEY가 있으면 실물, 없으면 결정적 fake 단독이다 (e2e·로컬).
 */
import { FakeGroundednessJudge } from './fake-groundedness-judge';
import { GroundednessJudge } from './groundedness-judge.port';
import { OpenAiGroundednessJudge } from './openai-groundedness-judge';

export function createGroundednessJudge(env: NodeJS.ProcessEnv): GroundednessJudge {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return new FakeGroundednessJudge();
  // 심판 전용 env를 늘리지 않는다 — 필요해지면 그때 (docs/specs/30)
  return new OpenAiGroundednessJudge({
    apiKey,
    model: env.OPENAI_MODEL?.trim() || 'gpt-5.4-mini',
    baseUrl: env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
  });
}
