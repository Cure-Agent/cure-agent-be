import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { CookieOptions } from 'express';
import { authConfig } from '../config/auth.config';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './token-resolver';

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

  private build(name: string, value: string, maxAgeMs: number): CookieSpec {
    const options: CookieOptions = {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: maxAgeMs,
    };
    const domain = this.config.cookieDomain;
    if (domain && domain.toLowerCase() !== 'localhost') {
      options.domain = domain;
    }
    return { name, value, options };
  }
}
