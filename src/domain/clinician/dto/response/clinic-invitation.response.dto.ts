import { ApiProperty } from '@nestjs/swagger';

export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * 초대 목록 항목 (docs/specs/35).
 *
 * **토큰 필드가 없다.** DB에는 sha256 해시만 있어 원문을 실을 수 없고, 발급 응답
 * (`ClinicInvitationIssuedResponseDto`)만이 원문을 보여준다.
 */
export class ClinicInvitationResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    enum: INVITATION_STATUSES,
    description: 'acceptedAt·revokedAt·expiresAt에서 파생한다 — 상태 컬럼은 없다',
  })
  status!: InvitationStatus;

  @ApiProperty()
  expiresAt!: string;

  @ApiProperty({ required: false, nullable: true })
  acceptedAt!: string | null;

  @ApiProperty({ required: false, nullable: true, description: '합류한 구성원의 표시 이름' })
  acceptedByDisplayName!: string | null;

  @ApiProperty()
  createdAt!: string;
}
