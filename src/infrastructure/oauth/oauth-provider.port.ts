/**
 * 소셜 로그인 프로바이더 포트 (docs/specs/17).
 * 도메인은 이 인터페이스만 알고, 제공자별 엔드포인트·응답 형태 차이는 구현체가 흡수한다.
 */

export const OAUTH_PROVIDER_IDS = ['GOOGLE', 'KAKAO', 'NAVER'] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

/** 제공자 응답을 정규화한 프로필. 이메일은 동의 항목이라 없을 수 있다. */
export interface OAuthProfile {
  provider: OAuthProviderId;
  /** 제공자가 부여한 불변 사용자 식별자 — 계정 동일성의 단일 기준 */
  providerId: string;
  email: string | null;
  displayName: string | null;
}

export interface OAuthProvider {
  readonly id: OAuthProviderId;

  /** 동의 화면 URL. state는 CSRF 방어용이며 콜백에서 쿠키와 대조한다. */
  authorizationUrl(params: { state: string; redirectUri: string }): string;

  /** authorization code → access token 교환 → 사용자 프로필 조회 */
  fetchProfile(params: { code: string; state: string; redirectUri: string }): Promise<OAuthProfile>;
}

/** 프로바이더 호출 실패(네트워크·토큰 교환·프로필 조회). 컨트롤러가 OAUTH 에러코드로 변환한다. */
export class OAuthProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthProviderError';
  }
}
