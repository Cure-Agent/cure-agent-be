import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';
import { clinicInvitationConfig } from '../../../global/config/clinic-invitation.config';
import { decodeCursor, encodeCursor } from '../../../global/common/cursor/cursor.util';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { PageResult } from '../../../global/common/response/page-result';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { ListClinicInvitationsQueryDto } from '../dto/request/list-clinic-invitations.query.dto';
import { ClinicInvitationIssuedResponseDto } from '../dto/response/clinic-invitation-issued.response.dto';
import { ClinicInvitationPreviewResponseDto } from '../dto/response/clinic-invitation-preview.response.dto';
import { ClinicInvitationResponseDto } from '../dto/response/clinic-invitation.response.dto';
import { toClinicInvitationDto } from '../mapper/clinic-invitation.mapper';
import { ClinicInvitationRow } from '../persistence/clinic-invitation.schema';
import { ClinicInvitationRepository } from '../repository/clinic-invitation.repository';

/** 합류 시 auth가 요구하는 초대 해석 결과 */
export interface ResolvedInvitation {
  invitationId: string;
  clinicId: string;
}

interface InvitationCursor extends Record<string, unknown> {
  createdAt: string;
  id: string;
}

const DEFAULT_SIZE = 20;
const DAY_MS = 24 * 60 * 60 * 1_000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 클리닉 초대 (docs/specs/35).
 *
 * **개설자 판정은 여기 없다** — `ClinicOwnerGuard`가 라우트 앞단에서 본다. 이 서비스의 의존은
 * 리포지토리와 설정 둘뿐이며, 그래야 만료 경계(기준 4·18)를 시각 주입만으로 단위 검증할 수 있다.
 */
@Injectable()
export class ClinicInvitationService {
  constructor(
    private readonly repository: ClinicInvitationRepository,
    @Inject(clinicInvitationConfig.KEY)
    private readonly config: ConfigType<typeof clinicInvitationConfig>,
  ) {}

  /**
   * 발급 — 토큰은 `{invitationId}.{secret}`이고 DB에는 secret의 sha256만 남는다(§4.3 refresh
   * 관행). 그래서 이 응답이 원문을 보여줄 **유일한 기회**이며 분실 시 재발급뿐이다.
   */
  async issue(principal: ClinicianPrincipal): Promise<ClinicInvitationIssuedResponseDto> {
    const id = ulid();
    const secret = randomBytes(32).toString('base64url');
    const now = new Date(Date.now());
    const expiresAt = new Date(now.getTime() + this.config.ttlDays * DAY_MS);

    const row = await this.repository.insert({
      id,
      clinicId: principal.clinicId,
      invitedByClinicianId: principal.clinicianId,
      tokenHash: sha256(secret),
      expiresAt,
    });

    return { ...toClinicInvitationDto(row, null, now), token: `${id}.${secret}` };
  }

  async list(
    principal: ClinicianPrincipal,
    query: ListClinicInvitationsQueryDto,
  ): Promise<PageResult<ClinicInvitationResponseDto>> {
    const size = query.size ?? DEFAULT_SIZE;
    const after = query.cursor ? decodeCursor<InvitationCursor>(query.cursor) : undefined;

    const rows = await this.repository.list(principal.clinicId, { after, limit: size + 1 });
    const hasNext = rows.length > size;
    const page = rows.slice(0, size);
    const now = new Date(Date.now());
    const last = page[page.length - 1];

    return PageResult.of(
      page.map((row) => toClinicInvitationDto(row.invitation, row.acceptedByDisplayName, now)),
      {
        size,
        hasNext,
        nextCursor: hasNext
          ? encodeCursor({ createdAt: last.cursorCreatedAt, id: last.invitation.id })
          : null,
      },
    );
  }

  /** 타 클리닉 초대는 0행이라 미존재와 구분되지 않는다 — 둘 다 404다 (§4.4) */
  async revoke(principal: ClinicianPrincipal, invitationId: string): Promise<null> {
    const revoked = await this.repository.revoke(
      principal.clinicId,
      invitationId,
      new Date(Date.now()),
    );
    if (!revoked) throw new ServiceException('NOT_FOUND');
    return null;
  }

  /** 비인증 프리뷰 — 링크만 가진 외부인에게 주는 정보를 한의원명으로 한정한다 */
  async preview(token: string): Promise<ClinicInvitationPreviewResponseDto> {
    const parsed = parseToken(token);
    const found = parsed ? await this.repository.findWithClinicName(parsed.id) : null;
    if (!found || !isUsable(found.invitation, parsed!.secret, new Date(Date.now()))) {
      throw new ServiceException('INVITATION_INVALID');
    }
    return { clinicName: found.clinicName };
  }

  /**
   * 합류 경로의 토큰 해석. 소비는 하지 않는다 — 가입 트랜잭션 안에서 `consume`이 따로 한다.
   * 만료 판정 기준 시각을 **인자로 받는다**: SQL의 `now()`로 계산하면 기준 18의 시각 주입이
   * 성립하지 않는다 (§34 기준 14와 같은 이유).
   */
  async resolveForJoin(token: string, now: Date): Promise<ResolvedInvitation> {
    const parsed = parseToken(token);
    const row = parsed ? await this.repository.findById(parsed.id) : null;
    if (!row || !isUsable(row, parsed!.secret, now)) {
      throw new ServiceException('INVITATION_INVALID');
    }
    return { invitationId: row.id, clinicId: row.clinicId };
  }

  /**
   * 1회용 소비. 조건부 UPDATE가 0행이면 그 사이에 누가 먼저 썼다는 뜻이므로 같은
   * `INVITATION_INVALID`로 수렴시킨다 — 해석과 소비 사이의 경합도 「이미 쓴 링크」다.
   */
  async consume(invitationId: string, clinicianId: string, now: Date): Promise<void> {
    const consumed = await this.repository.consume(invitationId, now, clinicianId);
    if (!consumed) throw new ServiceException('INVITATION_INVALID');
  }
}

function parseToken(token: string): { id: string; secret: string } | null {
  const separator = token.indexOf('.');
  if (separator <= 0 || separator === token.length - 1) return null;
  return { id: token.slice(0, separator), secret: token.slice(separator + 1) };
}

/** 상태·해시 검사를 한 곳에 모은다 — 프리뷰와 합류가 같은 기준으로 갈려야 한다 */
function isUsable(row: ClinicInvitationRow, secret: string, now: Date): boolean {
  if (row.acceptedAt || row.revokedAt) return false;
  if (row.expiresAt.getTime() <= now.getTime()) return false;

  const given = Buffer.from(sha256(secret), 'hex');
  const stored = Buffer.from(row.tokenHash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}
