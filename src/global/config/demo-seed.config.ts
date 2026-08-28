import { registerAs } from '@nestjs/config';

/**
 * 데모 환자 시딩 설정 (docs/specs/41).
 *
 * **env 해석은 구현에서 한다** — 여기는 시그니처만이다. 기본값 방향이 다른 불리언 스위치와
 * 반대(`=== 'true'`만 켬)라는 것이 기준 2·3의 단언 대상이므로, 스텁이 그 해석을 미리
 * 넣으면 오라클이 검증할 것이 없어진다.
 */
export const demoSeedConfig = registerAs('demoSeed', () => ({
  enabled: false as boolean,
}));
