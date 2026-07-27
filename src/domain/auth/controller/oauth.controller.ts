import { Controller, Get, Inject, Logger, Param, Query, Req, Res } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { ErrorCode } from '../../../global/common/exception/error-code.registry';
import { ApiEnvelopeResponse } from '../../../global/common/response/api-envelope.decorator';
import { oauthConfig } from '../../../global/config/oauth.config';
import { AuthCookieFactory, CookieSpec } from '../../../global/security/auth-cookie.factory';
import { Public } from '../../../global/security/public.decorator';
import { TokenResolver } from '../../../global/security/token-resolver';
import { OAuthProviderError } from '../../../infrastructure/oauth/oauth-provider.port';
import { OAuthProviderRegistry } from '../../../infrastructure/oauth/oauth-provider.registry';
import { OAuthProvidersResponseDto } from '../dto/response/oauth-provider.response.dto';
import { AuthService, IssuedAuth } from '../service/auth.service';

/** 콜백이 브라우저를 되돌려 보내는 FE 경로 (docs/specs/17) */
const FE_PATH = {
  success: '/assistant',
  signup: '/signup',
  failure: '/login',
} as const;

/**
 * 소셜 로그인 리다이렉트 플로우 (docs/specs/17).
 *
 * 콜백은 **FE 오리진의 `/api/v1/...`** 로 받는다(Next rewrites 프록시 경유). 제공자가
 * 브라우저를 BE 오리진으로 직접 보내면 발급 쿠키가 BE 도메인에 저장돼 FE 요청에 실리지 않는다.
 *
 * 이 컨트롤러의 실패는 JSON 봉투가 아니라 로그인 페이지 `?error=<code>`로 전달된다 —
 * 브라우저 내비게이션 도중이라 사용자에게 원시 JSON을 보여줄 수 없기 때문이다.
 */
@ApiTags('Auth')
@Controller('auth/oauth')
export class OAuthController {
  private readonly logger = new Logger(OAuthController.name);

  constructor(
    @Inject(oauthConfig.KEY)
    private readonly config: ConfigType<typeof oauthConfig>,
    private readonly registry: OAuthProviderRegistry,
    private readonly authService: AuthService,
    private readonly cookieFactory: AuthCookieFactory,
    private readonly tokenResolver: TokenResolver,
  ) {}

  @Public()
  @Get('providers')
  @ApiOperation({ summary: '활성 소셜 로그인 제공자 목록' })
  @ApiEnvelopeResponse(OAuthProvidersResponseDto)
  listProviders(): OAuthProvidersResponseDto {
    return { providers: this.registry.enabledIds() };
  }

  @Public()
  @Get(':provider')
  @ApiOperation({
    summary: '소셜 로그인 시작 — 제공자 동의 화면으로 302',
    description: 'FE는 fetch가 아니라 브라우저 내비게이션(location 이동)으로 호출한다.',
  })
  start(
    @Param('provider') providerId: string,
    @Res() res: Response,
  ): void {
    const provider = this.registry.find(providerId);
    if (!provider) {
      this.redirectFailure(res, 'AUTH_OAUTH_PROVIDER_UNSUPPORTED');
      return;
    }

    const state = randomBytes(32).toString('base64url');
    this.applyCookie(res, this.cookieFactory.issueOAuthState(state, this.config.stateTtlSec));
    res.redirect(
      provider.authorizationUrl({ state, redirectUri: this.redirectUri(provider.id) }),
    );
  }

  @Public()
  @Get(':provider/callback')
  @ApiExcludeEndpoint() // 제공자가 브라우저를 보내는 엔드포인트 — FE가 직접 호출하지 않는다
  async callback(
    @Param('provider') providerId: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') providerError: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // state 쿠키는 성공·실패 무관하게 1회용으로 소멸시킨다
    const expectedState = this.tokenResolver.resolveOAuthState(req);
    this.applyCookie(res, this.cookieFactory.expireOAuthState());

    try {
      // 사용자가 동의 화면에서 취소한 경우 — 제공자가 error 파라미터로 되돌려 보낸다
      if (providerError) throw new ServiceException('AUTH_OAUTH_DENIED');

      const provider = this.registry.find(providerId);
      if (!provider) throw new ServiceException('AUTH_OAUTH_PROVIDER_UNSUPPORTED');
      if (!code) throw new ServiceException('AUTH_OAUTH_FAILED');
      if (!state || !expectedState || !constantTimeEquals(state, expectedState)) {
        throw new ServiceException('AUTH_OAUTH_STATE_MISMATCH');
      }

      const profile = await provider.fetchProfile({
        code,
        state,
        redirectUri: this.redirectUri(provider.id),
      });
      const outcome = await this.authService.socialLogin(profile);

      if (outcome.status === 'SIGNUP_REQUIRED') {
        res.redirect(this.feUrl(FE_PATH.signup, { ticket: outcome.ticket }));
        return;
      }

      this.setAuthCookies(res, outcome.issued);
      res.redirect(this.feUrl(FE_PATH.success));
    } catch (error) {
      this.redirectFailure(res, this.toErrorCode(error, providerId));
    }
  }

  // ── 내부 구현 ─────────────────────────────────────────────

  /** 토큰 교환 때도 같은 값을 보내야 하므로 단일 지점에서 만든다. */
  private redirectUri(providerId: string): string {
    return `${this.config.webBaseUrl}/api/v1/auth/oauth/${providerId.toLowerCase()}/callback`;
  }

  private feUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`${this.config.webBaseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  private redirectFailure(res: Response, code: ErrorCode): void {
    res.redirect(this.feUrl(FE_PATH.failure, { error: code }));
  }

  /** 프로바이더 호출 실패는 원인을 서버 로그에만 남기고, 사용자에겐 일반 실패로 알린다. */
  private toErrorCode(error: unknown, providerId: string): ErrorCode {
    if (error instanceof ServiceException) return error.code;
    if (error instanceof OAuthProviderError) {
      this.logger.warn(`OAuth 콜백 실패 (${providerId}): ${error.message}`);
      return 'AUTH_OAUTH_FAILED';
    }
    this.logger.error(`OAuth 콜백 처리 중 예기치 못한 오류 (${providerId}): ${String(error)}`);
    return 'AUTH_OAUTH_FAILED';
  }

  private setAuthCookies(res: Response, issued: IssuedAuth): void {
    this.applyCookie(res, this.cookieFactory.issueAccess(issued.accessToken));
    this.applyCookie(res, this.cookieFactory.issueRefresh(issued.refreshCookieValue));
  }

  private applyCookie(res: Response, spec: CookieSpec): void {
    res.cookie(spec.name, spec.value, spec.options);
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
