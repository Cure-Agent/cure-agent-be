/**
 * 제공자별 엔드포인트·프로필 매핑 정의 (docs/specs/17).
 * 프로토콜(code → token → userinfo)은 셋 다 같으므로 HttpOAuthProvider 하나가 처리하고,
 * 달라지는 부분만 여기에 데이터로 모은다.
 */
import { OAuthProviderId } from '../oauth-provider.port';

export interface RawProfile {
  providerId: string | null;
  email: string | null;
  displayName: string | null;
}

export interface OAuthProviderDefinition {
  id: OAuthProviderId;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  /** 공백 구분 scope. 이메일은 신규 가입에 필요하므로 전 제공자에서 요청한다. */
  scope: string;
  /** 동의 화면 URL에 붙일 제공자 고유 파라미터 */
  extraAuthorizationParams?: Record<string, string>;
  /** 토큰 교환 요청에 state를 함께 보내야 하는 제공자(naver) */
  sendStateOnTokenExchange?: boolean;
  toProfile(raw: Record<string, unknown>): RawProfile;
}

export const GOOGLE_DEFINITION: OAuthProviderDefinition = {
  id: 'GOOGLE',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
  scope: 'openid email profile',
  toProfile: (raw) => ({
    providerId: str(raw.sub),
    email: str(raw.email),
    displayName: str(raw.name),
  }),
};

export const KAKAO_DEFINITION: OAuthProviderDefinition = {
  id: 'KAKAO',
  authorizationUrl: 'https://kauth.kakao.com/oauth/authorize',
  tokenUrl: 'https://kauth.kakao.com/oauth/token',
  userInfoUrl: 'https://kapi.kakao.com/v2/user/me',
  // account_email은 카카오 콘솔에서 "선택 동의"로만 열 수 있어 미동의 응답을 항상 감안해야 한다.
  // profile_nickname은 요청하지 않는다 — 콘솔에 열려 있지 않은 항목을 요청하면 인가 단계에서 거부되고,
  // 이름은 어차피 온보딩 폼에서 직접 받는다.
  scope: 'account_email',
  toProfile: (raw) => {
    const account = obj(raw.kakao_account);
    // 닉네임은 요청하지 않으므로 보통 비어 있다 — 콘솔에서 동의 항목을 열면 그때부터 폼 기본값으로 쓰인다
    const profile = obj(account?.profile);
    return {
      providerId: str(raw.id),
      email: str(account?.email),
      displayName: str(profile?.nickname),
    };
  },
};

export const NAVER_DEFINITION: OAuthProviderDefinition = {
  id: 'NAVER',
  authorizationUrl: 'https://nid.naver.com/oauth2.0/authorize',
  tokenUrl: 'https://nid.naver.com/oauth2.0/token',
  userInfoUrl: 'https://openapi.naver.com/v1/nid/me',
  scope: 'email name',
  sendStateOnTokenExchange: true,
  toProfile: (raw) => {
    const response = obj(raw.response);
    return {
      providerId: str(response?.id),
      email: str(response?.email),
      displayName: str(response?.name),
    };
  },
};

/** 숫자 id(kakao)도 문자열로 정규화한다. 빈 문자열은 미제공과 같게 취급한다. */
function str(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}
