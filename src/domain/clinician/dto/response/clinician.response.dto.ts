import { ApiProperty } from '@nestjs/swagger';
import { ClinicSummaryResponseDto } from './clinic-summary.response.dto';

export const VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export class ClinicianResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ type: ClinicSummaryResponseDto })
  clinic!: ClinicSummaryResponseDto;

  @ApiProperty({ enum: VERIFICATION_STATUSES })
  verificationStatus!: VerificationStatus;
}
