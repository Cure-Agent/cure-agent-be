import { ApiProperty } from '@nestjs/swagger';
import { ClinicInvitationResponseDto } from './clinic-invitation.response.dto';

/**
 * 초대 발급 응답 (docs/specs/35).
 *
 * `token`이 실리는 **유일한 응답**이다 — DB에는 sha256만 저장하므로 이후 어떤 조회로도 원문을
 * 되찾을 수 없다. 분실 시 재발급뿐이다.
 */
export class ClinicInvitationIssuedResponseDto extends ClinicInvitationResponseDto {
  @ApiProperty({
    description: '초대 링크 토큰 `{invitationId}.{secret}` — 이 응답에서만 노출된다',
  })
  token!: string;
}
