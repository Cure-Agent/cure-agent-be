import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { authConfig } from '../../../global/config/auth.config';
import { oauthConfig } from '../../../global/config/oauth.config';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { TraceContext } from '../../../global/context/trace-context.service';
import { RealTimeAlertSender } from '../../../global/observability/real-time-alert.sender';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { TokenDenylistService } from '../../../global/security/token-denylist.service';
import { AesGcmUtil } from '../../../global/security/crypto/aes-gcm.util';
import { OAuthProfile } from '../../../infrastructure/oauth/oauth-provider.port';
import { toClinicianResponse } from '../../clinician/mapper/clinician.mapper';
import { ClinicianRepository } from '../../clinician/repository/clinician.repository';
import { AuthSessionRepository } from '../repository/auth-session.repository';
import { AuthSessionRow } from '../persistence/auth-session.schema';
import { CompleteSignUpRequestDto } from '../dto/request/complete-sign-up.request.dto';
import { AuthSessionResponseDto } from '../dto/response/auth-session.response.dto';
import { OAuthTicketService } from './oauth-ticket.service';

export interface IssuedAuth {
  session: AuthSessionResponseDto;
  accessToken: string;
  /** refresh 쿠키 값: `<sessionId>.<secret>` — DB에는 secret의 sha256만 저장한다 */
  refreshCookieValue: string;
}

/** 콜백의 분기 결과: 기존 회원이면 세션, 신규면 온보딩 티켓 (docs/specs/17) */
export type SocialLoginOutcome =
  | { status: 'LOGIN_SUCCESS'; issued: IssuedAuth }
  | { status: 'SIGNUP_REQUIRED'; ticket: string };

@Injectable()
export class AuthService {
  constructor(
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
    @Inject(oauthConfig.KEY)
    private readonly oauth: ConfigType<typeof oauthConfig>,
    private readonly txManager: TransactionManager,
    private readonly jwtService: JwtService,
    private readonly tokenDenylist: TokenDenylistService,
    private readonly aesGcm: AesGcmUtil,
    private readonly alertSender: RealTimeAlertSender,
    private readonly traceContext: TraceContext,
    private readonly clinicianRepository: ClinicianRepository,
    private readonly sessionRepository: AuthSessionRepository,
    private readonly ticketService: OAuthTicketService,
  ) {}

  /**
   * 검증된 소셜 프로필로 로그인하거나, 미가입이면 온보딩 티켓을 발급한다 (docs/specs/17).
   * 기존 회원 식별은 provider+providerId로만 한다 — 이메일 미동의 계정도 로그인할 수 있다.
   */
  async socialLogin(profile: OAuthProfile): Promise<SocialLoginOutcome> {
    const existing = await this.clinicianRepository.findByOAuthAccount(
      profile.provider,
      profile.providerId,
    );
    if (existing) {
      return { status: 'LOGIN_SUCCESS', issued: await this.issueAuth(existing.clinician.id) };
    }

    // 신규 가입에는 이메일이 필요하다 — 의료인 연락 수단이자 중복 가입 방지 축이다
    if (!profile.email) throw new ServiceException('AUTH_OAUTH_EMAIL_MISSING');

    const ticket = await this.ticketService.issue(
      {
        provider: profile.provider,
        providerId: profile.providerId,
        email: profile.email,
        displayName: profile.displayName,
      },
      this.oauth.ticketTtlSec,
    );
    return { status: 'SIGNUP_REQUIRED', ticket };
  }

  /**
   * 온보딩 완료 — 티켓이 보관한 소셜 신원 + 폼 입력(한의원명·면허번호)으로 계정을 만든다.
   * 소셜 신원은 서버에만 있으므로 FE가 이메일·providerId를 위조할 수 없다.
   */
  async completeSignUp(dto: CompleteSignUpRequestDto): Promise<IssuedAuth> {
    const payload = await this.ticketService.consume(dto.ticket);

    if (await this.clinicianRepository.existsByEmail(payload.email)) {
      throw new ServiceException('AUTH_EMAIL_ALREADY_USED');
    }

    const clinicId = ulid();
    const clinicianId = ulid();

    return this.txManager.run(async () => {
      await this.clinicianRepository.insertClinic({ id: clinicId, name: dto.clinicName });
      await this.clinicianRepository.insertClinician({
        id: clinicianId,
        clinicId,
        email: payload.email,
        oauthProvider: payload.provider,
        oauthProviderId: payload.providerId,
        displayName: dto.displayName,
        licenseNumberEncrypted: this.aesGcm.encrypt(dto.licenseNumber),
      });
      return this.issueAuth(clinicianId);
    });
  }

  /** refresh rotation + 재사용 감지 (architecture.md §4.3) */
  async refresh(refreshCookie: string | null): Promise<IssuedAuth> {
    const session = await this.resolveSession(refreshCookie);

    // rotated·revoked 세션의 재사용 = 탈취 신호 → family 전체 폐기 + access 즉시 차단 + 알림
    if (session.rotatedAt || session.revokedAt) {
      await this.sessionRepository.revokeFamily(session.familyId, new Date(), session.id);
      await this.tokenDenylist.denyFamily(session.familyId, this.config.accessTtlSec);
      this.alertSender.send({
        title: 'AUTH_REFRESH_REUSED',
        detail: `refresh 토큰 재사용 감지 — family 전체 폐기 (clinician=${session.clinicianId})`,
        traceId: this.traceContext.traceId,
      });
      throw new ServiceException('AUTH_REFRESH_REUSED');
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new ServiceException('AUTH_TOKEN_EXPIRED');
    }

    return this.txManager.run(async () => {
      await this.sessionRepository.markRotated(session.id, new Date());
      return this.issueAuth(session.clinicianId, session.familyId);
    });
  }

  /** family 폐기(DB) + 이미 발급된 access 토큰 즉시 무효화(denylist) */
  async logout(principal: ClinicianPrincipal): Promise<void> {
    await this.sessionRepository.revokeFamily(principal.familyId, new Date());
    await this.tokenDenylist.denyFamily(principal.familyId, this.config.accessTtlSec);
  }

  async me(principal: ClinicianPrincipal): Promise<AuthSessionResponseDto['clinician']> {
    const found = await this.clinicianRepository.findById(principal.clinicianId);
    if (!found) throw new ServiceException('UNAUTHORIZED');
    return toClinicianResponse(found.clinician, found.clinic);
  }

  // ── 내부 구현 ─────────────────────────────────────────────

  private async issueAuth(clinicianId: string, familyId?: string): Promise<IssuedAuth> {
    const found = await this.clinicianRepository.findById(clinicianId);
    if (!found) throw new ServiceException('UNAUTHORIZED');

    const sessionId = ulid();
    const family = familyId ?? ulid();
    const secret = randomBytes(32).toString('base64url');
    const refreshExpiresAt = new Date(
      Date.now() + this.config.refreshTtlDays * 24 * 60 * 60 * 1000,
    );

    await this.sessionRepository.insert({
      id: sessionId,
      clinicianId,
      familyId: family,
      refreshTokenHash: sha256(secret),
      expiresAt: refreshExpiresAt,
    });

    const accessExpiresAt = new Date(Date.now() + this.config.accessTtlSec * 1000);
    const accessToken = await this.jwtService.signAsync({
      sub: clinicianId,
      clinicId: found.clinician.clinicId,
      sid: sessionId,
      fid: family,
    });

    return {
      session: {
        clinician: toClinicianResponse(found.clinician, found.clinic),
        expiresAt: accessExpiresAt.toISOString(),
      },
      accessToken,
      refreshCookieValue: `${sessionId}.${secret}`,
    };
  }

  private async resolveSession(refreshCookie: string | null): Promise<AuthSessionRow> {
    const parsed = this.parseRefreshCookie(refreshCookie);
    if (!parsed) throw new ServiceException('UNAUTHORIZED');

    const session = await this.sessionRepository.findById(parsed.sessionId);
    if (!session || !this.refreshSecretMatches(parsed.secret, session)) {
      throw new ServiceException('UNAUTHORIZED');
    }
    return session;
  }

  private parseRefreshCookie(value: string | null): { sessionId: string; secret: string } | null {
    if (!value) return null;
    const parts = value.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { sessionId: parts[0], secret: parts[1] };
  }

  private refreshSecretMatches(secret: string, session: AuthSessionRow): boolean {
    const given = Buffer.from(sha256(secret), 'hex');
    const stored = Buffer.from(session.refreshTokenHash, 'hex');
    return given.length === stored.length && timingSafeEqual(given, stored);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
