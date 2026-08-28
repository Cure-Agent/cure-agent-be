import { registerAs } from '@nestjs/config';

/**
 * 데모 환자 시딩 설정 (docs/specs/41).
 *
 * **기본값이 꺼짐인 이유**가 이 플래그의 존재 이유다. 다른 불리언 env(`LLM_ANSWERABILITY_GATE_ENABLED`)는
 * `!== 'false'`로 기본 켜짐이지만 여기는 반대로 `=== 'true'`만 켠다 — 동결된 수용 기준 e2e가
 * 「가입 직후 클리닉은 비어 있다」를 전제하기 때문이다(§09 기준 2는 새 클리닉에 환자 3건을 만들고
 * 2+1 페이지를 단언한다). 기본값이 켜짐이면 그 단언이 6건을 보게 된다.
 *
 * 켜는 자리는 배포 환경뿐이다 — 라이브 데모에 처음 들어온 사람이 환자를 직접 등록하지 않고도
 * 환자 맞춤 대화까지 걸어볼 수 있게 하는 것이 목적이다.
 */
export const demoSeedConfig = registerAs('demoSeed', () => ({
  enabled: process.env.DEMO_SEED_ENABLED === 'true',
}));
