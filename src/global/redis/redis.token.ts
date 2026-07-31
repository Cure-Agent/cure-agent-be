/**
 * Redis 클라이언트 주입 토큰.
 *
 * **모듈 파일이 아니라 여기 있는 이유**: `RedisModule`이 같은 디렉토리의 provider
 * (`RedisLock`)를 import하는데, 그 provider가 토큰을 모듈에서 가져오면 순환 import가 되어
 * 주입 인자가 런타임에 undefined가 된다(docs/specs/26 구현 중 실측). 토큰만 떼어두면
 * 모듈 → provider 단방향이 유지된다.
 */
export const REDIS = Symbol('REDIS');
