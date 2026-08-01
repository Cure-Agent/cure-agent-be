/**
 * 심판 등록 정책 (docs/specs/30) — 리랭커 팩토리(docs/specs/29) 선례를 따른다:
 * OPENAI_API_KEY가 있으면 실물, 없으면 결정적 fake 단독이다 (e2e·로컬).
 */
import { FakeGroundednessJudge } from './fake-groundedness-judge';
import { GroundednessJudge } from './groundedness-judge.port';

/** TODO(docs/specs/30 기준 8): 키가 있으면 OpenAiGroundednessJudge를 등록한다 */
export function createGroundednessJudge(_env: NodeJS.ProcessEnv): GroundednessJudge {
  return new FakeGroundednessJudge();
}
