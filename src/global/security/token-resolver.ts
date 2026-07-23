import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';

/** 쿠키(기본) → Authorization Bearer(도구용 폴백) 순으로 토큰을 추출한다. */
@Injectable()
export class TokenResolver {
  resolveAccess(request: Request): string | null {
    const fromCookie = (request.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
    if (fromCookie) return fromCookie;

    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
    return null;
  }

  resolveRefresh(request: Request): string | null {
    return (request.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE] ?? null;
  }
}
