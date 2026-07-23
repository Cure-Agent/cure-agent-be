import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { authConfig } from '../../../global/config/auth.config';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { TraceContext } from '../../../global/context/trace-context.service';
import { RealTimeAlertSender } from '../../../global/observability/real-time-alert.sender';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { PasswordHasher } from '../../../global/security/password-hasher';
import { TokenDenylistService } from '../../../global/security/token-denylist.service';
import { AesGcmUtil } from '../../../global/security/crypto/aes-gcm.util';
import { toClinicianResponse } from '../../clinician/mapper/clinician.mapper';
import { ClinicianRepository } from '../../clinician/repository/clinician.repository';
import { AuthSessionRepository } from '../repository/auth-session.repository';
import { AuthSessionRow } from '../persistence/auth-session.schema';
import { LoginRequestDto } from '../dto/request/login.request.dto';
import { SignUpRequestDto } from '../dto/request/sign-up.request.dto';
import { AuthSessionResponseDto } from '../dto/response/auth-session.response.dto';
import { EmailAvailabilityResponseDto } from '../dto/response/email-availability.response.dto';

export interface IssuedAuth {
  session: AuthSessionResponseDto;
  accessToken: string;
  /** refresh 쿠키 값: `<sessionId>.<secret>` — DB에는 secret의 sha256만 저장한다 */
  refreshCookieValue: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
    private readonly txManager: TransactionManager,
    private readonly jwtService: JwtService,
    private readonly passwordHasher: PasswordHasher,
    private readonly tokenDenylist: TokenDenylistService,
    private readonly aesGcm: AesGcmUtil,
    private readonly alertSender: RealTimeAlertSender,
    private readonly traceContext: TraceContext,
    private readonly clinicianRepository: ClinicianRepository,
    private readonly sessionRepository: AuthSessionRepository,
  ) {}

  async signUp(dto: SignUpRequestDto): Promise<IssuedAuth> {
    if (await this.clinicianRepository.existsByEmail(dto.email)) {
      throw new ServiceException('AUTH_EMAIL_ALREADY_USED');
    }

    const clinicId = ulid();
    const clinicianId = ulid();
    const passwordHash = await this.passwordHasher.hash(dto.password);

    return this.txManager.run(async () => {
      await this.clinicianRepository.insertClinic({ id: clinicId, name: dto.clinicName });
      await this.clinicianRepository.insertClinician({
        id: clinicianId,
        clinicId,
        email: dto.email,
        passwordHash,
        displayName: dto.displayName,
        licenseNumberEncrypted: this.aesGcm.encrypt(dto.licenseNumber),
      });
      return this.issueAuth(clinicianId);
    });
  }

  async login(dto: LoginRequestDto): Promise<IssuedAuth> {
    const found = await this.clinicianRepository.findByEmail(dto.email);
    if (!found) throw new ServiceException('AUTH_INVALID_CREDENTIALS');

    const valid = await this.passwordHasher.verify(dto.password, found.clinician.passwordHash);
    if (!valid) throw new ServiceException('AUTH_INVALID_CREDENTIALS');

    return this.issueAuth(found.clinician.id);
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

  async emailAvailability(email: string): Promise<EmailAvailabilityResponseDto> {
    return { available: !(await this.clinicianRepository.existsByEmail(email)) };
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
