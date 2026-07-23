import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import type { Request } from 'express';
import { ServiceException } from '../common/exception/service.exception';
import { ClinicianPrincipal } from './clinician-principal';
import { IS_PUBLIC_KEY } from './public.decorator';
import { TokenDenylistService } from './token-denylist.service';
import { TokenResolver } from './token-resolver';

interface AccessTokenPayload {
  sub: string;
  clinicId: string;
  sid: string;
  fid: string;
}

/**
 * access 토큰 검증 가드. 서명·만료 검증(무DB) 후 denylist(Redis)만 확인한다 —
 * 로그아웃·재사용 감지된 family의 토큰은 TTL이 남아 있어도 즉시 거부된다 (§4.3).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly tokenResolver: TokenResolver,
    private readonly tokenDenylist: TokenDenylistService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { clinician: ClinicianPrincipal }>();
    const token = this.tokenResolver.resolveAccess(request);
    if (!token) throw new ServiceException('UNAUTHORIZED');

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);
    } catch (error) {
      if (error instanceof TokenExpiredError) throw new ServiceException('AUTH_TOKEN_EXPIRED');
      throw new ServiceException('UNAUTHORIZED');
    }

    if (await this.tokenDenylist.isDenied(payload.fid)) {
      throw new ServiceException('UNAUTHORIZED');
    }

    request.clinician = {
      clinicianId: payload.sub,
      clinicId: payload.clinicId,
      sessionId: payload.sid,
      familyId: payload.fid,
    };
    return true;
  }
}
