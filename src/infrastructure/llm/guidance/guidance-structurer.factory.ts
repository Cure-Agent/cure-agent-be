/**
 * 구조화기 등록 정책 (docs/specs/33 기준 8) — 리랭커 팩토리 선례에 킬스위치를 더한 3분기다:
 *
 * - 키 없음 → 결정적 fake (e2e·로컬)
 * - 키 있음 + `GUIDANCE_STRUCTURE_ENABLED=false` → disabled (구조화 안 함, 결정적 조립 유지)
 * - 키 있음 (기본) → 실물
 *
 * 키를 비워 끄는 방법은 쓸 수 없다 — 프로덕션은 같은 `OPENAI_API_KEY`를 메인 LLM과 공유하므로
 * 비우면 답변 생성 자체가 죽는다. 킬스위치를 별도 변수로 둔 이유가 그것이다.
 * 기본값이 on인 이유: 배포 자체가 측정 게이트 뒤에 있어 통과 상태가 기본이고, 미달 시
 * 기본값을 뒤집는 커밋이 곧 롤백이다.
 */
import { DisabledGuidanceStructurer } from './disabled-guidance-structurer';
import { FakeGuidanceStructurer } from './fake-guidance-structurer';
import { GuidanceStructurer } from './guidance-structurer.port';
import { OpenAiGuidanceStructurer } from './openai-guidance-structurer';

export function createGuidanceStructurer(env: NodeJS.ProcessEnv): GuidanceStructurer {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return new FakeGuidanceStructurer();
  // 정확히 'false'만 발동한다 — 오타·빈 값이 조용히 기능을 끄지 않게 한다
  if (env.GUIDANCE_STRUCTURE_ENABLED?.trim() === 'false') return new DisabledGuidanceStructurer();
  return new OpenAiGuidanceStructurer({
    apiKey,
    model: env.OPENAI_MODEL?.trim() || 'gpt-5.4-mini',
    baseUrl: env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
  });
}
