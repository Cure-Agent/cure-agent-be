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
import { MetricsService } from '../../../global/observability/metrics/metrics.service';
import { ClinicianRepository } from '../../clinician/repository/clinician.repository';
import {
  ClinicInvitationService,
  ResolvedInvitation,
} from '../../clinician/service/clinic-invitation.service';
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
    private readonly invitationService: ClinicInvitationService,
    private readonly metrics: MetricsService,
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

    // 두 필드의 상호 배타는 **한 프로퍼티가 아니라 요청 전체의 규칙**이라 DTO 데코레이터로
    // 표현하지 않는다 — class-validator의 ValidateIf를 같은 프로퍼티에 둘 쌓으면 두 조건이
    // AND로 묶여 검증이 아예 돌지 않는다. 조용히 무시하지 않는 이유는 스펙 기준 14와 같다:
    // 사용자가 입력한 한의원명이 어디로 갔는지 알 수 없고, 서버가 모순된 요청을 임의 해석하는 셈이다.
    if (dto.invitationToken && dto.clinicName !== undefined) {
      throw new ServiceException('VALIDATION_FAILED', undefined, 'invitationToken과 clinicName은 함께 올 수 없습니다.');
    }

    // 이메일 중복 검사가 초대 해석·소비보다 **앞선다** — 실패한 가입이 초대를 태우면 안 된다 (기준 17)
    if (await this.clinicianRepository.existsByEmail(payload.email)) {
      throw new ServiceException('AUTH_EMAIL_ALREADY_USED');
    }

    const clinicianId = ulid();
    const now = new Date(Date.now());

    const insertClinician = (clinicId: string) =>
      this.clinicianRepository.insertClinician({
        id: clinicianId,
        clinicId,
        email: payload.email,
        oauthProvider: payload.provider,
        oauthProviderId: payload.providerId,
        displayName: dto.displayName,
        licenseNumberEncrypted: this.aesGcm.encrypt(dto.licenseNumber),
      });

    // 합류 (docs/specs/35) — clinic을 만들지 않고 초대가 가리키는 클리닉에 붙는다.
    // 역할은 기본값 MEMBER 그대로다: 초대는 병원 합류이지 플랫폼 권한 승격이 아니다.
    if (dto.invitationToken) {
      // 만료·재사용·취소된 링크는 정상 방어이므로 실패로 세지 않고 rejected로 따로 센다
      let invitation: ResolvedInvitation;
      try {
        invitation = await this.invitationService.resolveForJoin(dto.invitationToken, now);
      } catch (error) {
        this.metrics.recordClinicInvitation('rejected');
        throw error;
      }

      return this.txManager.run(async () => {
        await insertClinician(invitation.clinicId);
        await this.invitationService.consume(invitation.invitationId, clinicianId, now);
        const issued = await this.issueAuth(clinicianId);
        this.metrics.recordClinicInvitation('accepted');
        return issued;
      });
    }

    if (!dto.clinicName) throw new ServiceException('VALIDATION_FAILED');
    const clinicName = dto.clinicName;
    const clinicId = ulid();

    return this.txManager.run(async () => {
      // 순환 FK라 owner는 clinician을 만든 뒤에야 채울 수 있다 (docs/specs/35)
      await this.clinicianRepository.insertClinic({ id: clinicId, name: clinicName });
      await insertClinician(clinicId);
      await this.clinicianRepository.updateClinicOwner(clinicId, clinicianId);
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

  /**
   * 회원탈퇴 (docs/specs/36) — 구현은 Phase 3.
   *
   * 순서가 계약이다: **판정 → 익명화 → clinic 예약 → 전 세션 폐기**. 409로 끝날 요청이
   * 개인정보를 먼저 지우면 되돌릴 수 없다 (기준 25·26).
   */
  /**
   * 회원탈퇴 (docs/specs/36).
   *
   * **순서가 계약이다.** 개설자 판정이 익명화보다 먼저 온다 — 409로 끝날 요청이 이메일·면허번호를
   * 먼저 지우면 되돌릴 수 없다(기준 25·26). 개인정보 파기는 즉시이고, 클리닉 데이터 파기만
   * §34의 유예 크론으로 미룬다.
   */
  async withdraw(principal: ClinicianPrincipal): Promise<void> {
    const activeMembers = await this.clinicianRepository.countActiveMembers(principal.clinicId);
    const ownerId = await this.clinicianRepository.findClinicOwnerId(principal.clinicId);
    const isLastMember = activeMembers <= 1;

    // 개설자가 남을 두고 떠나면 그 클리닉은 영구히 초대를 발급할 수 없는 잠긴 상태가 된다(§35).
    // 마지막 구성원은 넘길 상대가 없으므로 막지 않는다.
    if (ownerId === principal.clinicianId && !isLastMember) {
      this.metrics.recordClinicianWithdrawal('blocked');
      throw new ServiceException('CLINIC_OWNER_MUST_TRANSFER');
    }

    const now = new Date(Date.now());
    const familyIds = await this.sessionRepository.findFamilyIdsByClinician(principal.clinicianId);

    await this.txManager.run(async () => {
      await this.clinicianRepository.anonymize(principal.clinicianId, now);
      if (isLastMember) {
        await this.clinicianRepository.softDeleteClinic(principal.clinicId, now);
      }
      await this.sessionRepository.revokeAllByClinician(principal.clinicianId, now);
    });

    // denylist는 family 단위라 **폐기한 전 family**를 올려야 TTL이 남은 access 토큰이 막힌다.
    // 트랜잭션 밖인 이유는 Redis가 롤백 대상이 아니고, 실패해도 DB 폐기는 이미 확정이기 때문이다.
    await Promise.all(
      familyIds.map((familyId) => this.tokenDenylist.denyFamily(familyId, this.config.accessTtlSec)),
    );
    this.metrics.recordClinicianWithdrawal('withdrawn');
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
