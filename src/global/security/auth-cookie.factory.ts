import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { CookieOptions } from 'express';
import { authConfig } from '../config/auth.config';
import { ACCESS_COOKIE, OAUTH_STATE_COOKIE, REFRESH_COOKIE } from './token-resolver';

/** state 쿠키는 OAuth 콜백에서만 읽히므로 다른 요청에 실려 나가지 않게 경로를 좁힌다. */
const OAUTH_STATE_PATH = '/api/v1/auth/oauth';

export interface CookieSpec {
  name: string;
  value: string;
  options: CookieOptions;
}

/**
 * 인증 쿠키 발급·만료 팩토리 (architecture.md §4.1).
 * HttpOnly + Secure(운영) + SameSite=Lax + Path=/. dev는 domain 미지정 host-only 쿠키.
 */
@Injectable()
export class AuthCookieFactory {
  constructor(
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
  ) {}

  issueAccess(token: string): CookieSpec {
    return this.build(ACCESS_COOKIE, token, this.config.accessTtlSec * 1000);
  }

  issueRefresh(value: string): CookieSpec {
    return this.build(REFRESH_COOKIE, value, this.config.refreshTtlDays * 24 * 60 * 60 * 1000);
  }

  expireAccess(): CookieSpec {
    return this.build(ACCESS_COOKIE, '', 0);
  }

  expireRefresh(): CookieSpec {
    return this.build(REFRESH_COOKIE, '', 0);
  }

  /**
   * OAuth state 쿠키 (docs/specs/17).
   * 제공자 → 콜백은 top-level GET 내비게이션이라 SameSite=Lax로도 전달된다.
   */
  issueOAuthState(state: string, ttlSec: number): CookieSpec {
    return this.build(OAUTH_STATE_COOKIE, state, ttlSec * 1000, OAUTH_STATE_PATH);
  }

  expireOAuthState(): CookieSpec {
    return this.build(OAUTH_STATE_COOKIE, '', 0, OAUTH_STATE_PATH);
  }

  private build(name: string, value: string, maxAgeMs: number, path = '/'): CookieSpec {
    const options: CookieOptions = {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path,
      maxAge: maxAgeMs,
    };
    const domain = this.config.cookieDomain;
    if (domain && domain.toLowerCase() !== 'localhost') {
      options.domain = domain;
    }
    return { name, value, options };
  }
}
