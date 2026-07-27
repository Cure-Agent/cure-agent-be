import { registerAs } from '@nestjs/config';

/**
 * 소셜 로그인 설정 (docs/specs/17).
 * client id/secret은 전부 선택 env — 값이 있는 제공자만 등록된다(env.validation 필수화 금지).
 */
export const oauthConfig = registerAs('oauth', () => ({
  /**
   * 브라우저가 API에 도달하는 공개 오리진. FE 오리진을 넣는다 —
   * FE의 Next rewrites가 `/api/v1/*`을 BE로 프록시하므로 OAuth 콜백도 이 경로로 받아야
   * 발급 쿠키가 FE와 same-origin(first-party)으로 저장된다 (docs/specs/17).
   */
  webBaseUrl: stripTrailingSlash(process.env.OAUTH_WEB_BASE_URL ?? 'http://localhost:3001'),
  /** 신규 가입 티켓 수명(초). 온보딩 입력 시간을 감안한 기본 10분 */
  ticketTtlSec: parseInt(process.env.OAUTH_TICKET_TTL_SEC ?? '600', 10),
  /** state 쿠키 수명(초). 동의 화면 체류 시간 상한 */
  stateTtlSec: parseInt(process.env.OAUTH_STATE_TTL_SEC ?? '600', 10),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  },
  kakao: {
    // 카카오는 콘솔에서 client secret을 끌 수 있어 secret이 비어도 등록한다
    clientId: process.env.KAKAO_CLIENT_ID ?? '',
    clientSecret: process.env.KAKAO_CLIENT_SECRET ?? '',
  },
  naver: {
    clientId: process.env.NAVER_CLIENT_ID ?? '',
    clientSecret: process.env.NAVER_CLIENT_SECRET ?? '',
  },
}));

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
