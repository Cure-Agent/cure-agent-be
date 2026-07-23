import { registerAs } from '@nestjs/config';

export const authConfig = registerAs('auth', () => ({
  jwtSecret: process.env.AUTH_JWT_SECRET ?? '',
  /** access 토큰 수명(초). 기본 15분 */
  accessTtlSec: parseInt(process.env.AUTH_ACCESS_TTL_SEC ?? '900', 10),
  /** refresh 토큰 수명(일). 기본 14일 */
  refreshTtlDays: parseInt(process.env.AUTH_REFRESH_TTL_DAYS ?? '14', 10),
  /** COOKIE_SECURE: dev=false, prod=true (architecture.md §4.1) */
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  /** COOKIE_DOMAIN: dev=""(host-only), prod=운영 도메인 */
  cookieDomain: process.env.COOKIE_DOMAIN || null,
}));
