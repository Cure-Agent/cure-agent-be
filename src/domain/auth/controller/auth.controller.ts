import { Body, Controller, Delete, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ApiEnvelopeResponse } from '../../../global/common/response/api-envelope.decorator';
import { ApiResponseDto } from '../../../global/common/response/api-response.dto';
import { AuthCookieFactory, CookieSpec } from '../../../global/security/auth-cookie.factory';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { CurrentClinician } from '../../../global/security/current-clinician.decorator';
import { Public } from '../../../global/security/public.decorator';
import { TokenResolver } from '../../../global/security/token-resolver';
import { ClinicianResponseDto } from '../../clinician/dto/response/clinician.response.dto';
import { CompleteSignUpRequestDto } from '../dto/request/complete-sign-up.request.dto';
import { AuthSessionResponseDto } from '../dto/response/auth-session.response.dto';
import { AuthService, IssuedAuth } from '../service/auth.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly cookieFactory: AuthCookieFactory,
    private readonly tokenResolver: TokenResolver,
  ) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('signup')
  @ApiOperation({
    summary: '온보딩 완료 + 즉시 로그인 (쿠키 발급)',
    description:
      '소셜 콜백이 발급한 티켓과 한의원명·면허번호를 받아 가입을 마친다 (docs/specs/17). ' +
      '이메일·소셜 신원은 티켓에서 꺼내므로 바디로 받지 않는다.',
  })
  @ApiEnvelopeResponse(AuthSessionResponseDto, { status: 201 })
  async completeSignUp(
    @Body() dto: CompleteSignUpRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponseDto<AuthSessionResponseDto>> {
    const issued = await this.authService.completeSignUp(dto);
    this.setAuthCookies(res, issued);
    return ApiResponseDto.success(issued.session, 'CREATED');
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'access 재발급 + refresh rotation' })
  @ApiEnvelopeResponse(AuthSessionResponseDto)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionResponseDto> {
    const issued = await this.authService.refresh(this.tokenResolver.resolveRefresh(req));
    this.setAuthCookies(res, issued);
    return issued.session;
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: '로그아웃 — 세션 family 폐기 + access 즉시 무효화 + 쿠키 만료' })
  async logout(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponseDto<null>> {
    await this.authService.logout(principal);
    this.applyCookie(res, this.cookieFactory.expireAccess());
    this.applyCookie(res, this.cookieFactory.expireRefresh());
    return ApiResponseDto.success(null);
  }

  @Get('me')
  @ApiOperation({ summary: '현재 사용자 복구' })
  @ApiEnvelopeResponse(ClinicianResponseDto)
  me(@CurrentClinician() principal: ClinicianPrincipal): Promise<ClinicianResponseDto> {
    return this.authService.me(principal);
  }

  @Delete('me')
  @ApiOperation({
    summary: '회원탈퇴 — 개인정보 즉시 익명화 + 전 세션 폐기 (docs/specs/36)',
  })
  async withdraw(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponseDto<null>> {
    await this.authService.withdraw(principal);
    this.applyCookie(res, this.cookieFactory.expireAccess());
    this.applyCookie(res, this.cookieFactory.expireRefresh());
    return ApiResponseDto.success(null);
  }

  private setAuthCookies(res: Response, issued: IssuedAuth): void {
    this.applyCookie(res, this.cookieFactory.issueAccess(issued.accessToken));
    this.applyCookie(res, this.cookieFactory.issueRefresh(issued.refreshCookieValue));
  }

  private applyCookie(res: Response, spec: CookieSpec): void {
    res.cookie(spec.name, spec.value, spec.options);
  }
}
