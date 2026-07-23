import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ApiEnvelopeResponse } from '../../../global/common/response/api-envelope.decorator';
import { ApiResponseDto } from '../../../global/common/response/api-response.dto';
import { AuthCookieFactory } from '../../../global/security/auth-cookie.factory';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { CurrentClinician } from '../../../global/security/current-clinician.decorator';
import { Public } from '../../../global/security/public.decorator';
import { TokenResolver } from '../../../global/security/token-resolver';
import { ClinicianResponseDto } from '../../clinician/dto/response/clinician.response.dto';
import { EmailAvailabilityQueryDto } from '../dto/request/email-availability.query.dto';
import { LoginRequestDto } from '../dto/request/login.request.dto';
import { SignUpRequestDto } from '../dto/request/sign-up.request.dto';
import { AuthSessionResponseDto } from '../dto/response/auth-session.response.dto';
import { EmailAvailabilityResponseDto } from '../dto/response/email-availability.response.dto';
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
  @Post('signup')
  @ApiOperation({ summary: '의료인 가입 + 즉시 로그인 (쿠키 발급)' })
  @ApiEnvelopeResponse(AuthSessionResponseDto, { status: 201 })
  async signUp(
    @Body() dto: SignUpRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponseDto<AuthSessionResponseDto>> {
    const issued = await this.authService.signUp(dto);
    this.setAuthCookies(res, issued);
    return ApiResponseDto.success(issued.session, 'CREATED');
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: '이메일 로그인 (쿠키 발급)' })
  @ApiEnvelopeResponse(AuthSessionResponseDto)
  async login(
    @Body() dto: LoginRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionResponseDto> {
    const issued = await this.authService.login(dto);
    this.setAuthCookies(res, issued);
    return issued.session;
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

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('email-availability')
  @ApiOperation({ summary: '이메일 중복 확인 (rate limit 적용)' })
  @ApiEnvelopeResponse(EmailAvailabilityResponseDto)
  emailAvailability(
    @Query() query: EmailAvailabilityQueryDto,
  ): Promise<EmailAvailabilityResponseDto> {
    return this.authService.emailAvailability(query.email);
  }

  private setAuthCookies(res: Response, issued: IssuedAuth): void {
    this.applyCookie(res, this.cookieFactory.issueAccess(issued.accessToken));
    this.applyCookie(res, this.cookieFactory.issueRefresh(issued.refreshCookieValue));
  }

  private applyCookie(
    res: Response,
    spec: ReturnType<AuthCookieFactory['issueAccess']>,
  ): void {
    res.cookie(spec.name, spec.value, spec.options);
  }
}
