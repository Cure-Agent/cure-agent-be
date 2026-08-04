import { ApiProperty } from '@nestjs/swagger';

/**
 * 비인증 초대 프리뷰 (docs/specs/35) — 초대받은 사람은 아직 계정이 없다.
 *
 * **한의원명만 준다.** 링크만 가진 외부인에게 노출하는 정보를 여기로 한정한다 — clinicId·
 * 초대자 식별정보·invitationId는 싣지 않는다.
 */
export class ClinicInvitationPreviewResponseDto {
  @ApiProperty({ example: '서울한의원' })
  clinicName!: string;
}
