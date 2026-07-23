import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ServiceException } from '../common/exception/service.exception';

export const CSRF_HEADER = 'x-csrf-protection';

/**
 * CSRF 방어 (architecture.md §4.1).
 * SameSite=Lax에 더해, 상태 변경 요청은 커스텀 헤더 `X-CSRF-Protection: 1`을 요구한다.
 * 커스텀 헤더는 cross-origin form/단순 요청으로 위조할 수 없다.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private static readonly SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (CsrfGuard.SAFE_METHODS.has(request.method)) return true;
    if (request.headers[CSRF_HEADER]) return true;
    throw new ServiceException('CSRF_REJECTED');
  }
}
