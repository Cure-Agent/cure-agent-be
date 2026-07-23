import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import type { Request } from 'express';
import { ServiceException } from '../common/exception/service.exception';
import { ClinicianPrincipal } from './clinician-principal';
import { IS_PUBLIC_KEY } from './public.decorator';
import { TokenResolver } from './token-resolver';

interface AccessTokenPayload {
  sub: string;
  clinicId: string;
  sid: string;
}

/** access 토큰 검증 가드. 검증은 서명·만료만으로 하며 DB를 조회하지 않는다. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly tokenResolver: TokenResolver,
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

    try {
      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);
      request.clinician = {
        clinicianId: payload.sub,
        clinicId: payload.clinicId,
        sessionId: payload.sid,
      };
      return true;
    } catch (error) {
      if (error instanceof TokenExpiredError) throw new ServiceException('AUTH_TOKEN_EXPIRED');
      throw new ServiceException('UNAUTHORIZED');
    }
  }
}
