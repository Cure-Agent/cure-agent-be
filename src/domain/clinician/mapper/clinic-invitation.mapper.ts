import {
  ClinicInvitationResponseDto,
  InvitationStatus,
} from '../dto/response/clinic-invitation.response.dto';
import { ClinicInvitationRow } from '../persistence/clinic-invitation.schema';

/**
 * 상태 파생 (docs/specs/35) — 컬럼이 아니라 세 시각에서 계산한다.
 *
 * 순서가 의미를 갖는다: **합류가 취소·만료보다 앞선다.** 이미 합류한 초대는 그 사실이 최종
 * 사건이며, 뒤늦게 취소를 눌렀거나 만료 시각이 지났다고 「취소됨」·「만료됨」으로 보이면
 * 「누가 언제 합류했는가」라는 이 목록의 존재 이유가 가려진다.
 */
export function deriveInvitationStatus(row: ClinicInvitationRow, now: Date): InvitationStatus {
  if (row.acceptedAt) return 'ACCEPTED';
  if (row.revokedAt) return 'REVOKED';
  if (row.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'PENDING';
}

export function toClinicInvitationDto(
  row: ClinicInvitationRow,
  acceptedByDisplayName: string | null,
  now: Date,
): ClinicInvitationResponseDto {
  return {
    id: row.id,
    status: deriveInvitationStatus(row, now),
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    acceptedByDisplayName,
    createdAt: row.createdAt.toISOString(),
  };
}
