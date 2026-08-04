import { ApiProperty } from '@nestjs/swagger';

/**
 * 클리닉 구성원 (docs/specs/36).
 *
 * **전원에게 공개된다** — 환자·대화를 전원 공유하면서(§35) 동료가 누구인지 모르는 상태가 더
 * 이상하다. 탈퇴한 tombstone은 목록에서 제외되므로 익명화된 값이 노출되지 않는다.
 */
export class ClinicMemberResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ description: '개설자 여부 — 초대 발급·이양 권한을 가진 한 사람이다' })
  isOwner!: boolean;

  @ApiProperty({ description: '합류 시각' })
  joinedAt!: string;
}
