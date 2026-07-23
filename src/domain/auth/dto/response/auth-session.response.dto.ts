import { ApiProperty } from '@nestjs/swagger';
import { ClinicianResponseDto } from '../../../clinician/dto/response/clinician.response.dto';

/** 토큰은 HttpOnly 쿠키로만 전달되며 응답 바디에 포함하지 않는다 (architecture.md §4.1). */
export class AuthSessionResponseDto {
  @ApiProperty({ type: ClinicianResponseDto })
  clinician!: ClinicianResponseDto;

  @ApiProperty({ description: 'access 토큰 만료 시각 (ISO 8601)' })
  expiresAt!: string;
}
