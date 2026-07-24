import { ApiProperty } from '@nestjs/swagger';
import { PatientSummaryResponseDto } from './patient-summary.response.dto';

export class PatientDetailResponseDto extends PatientSummaryResponseDto {
  @ApiProperty({ required: false })
  birthYear?: number;

  @ApiProperty({ required: false })
  heightCm?: number;

  @ApiProperty({ required: false })
  weightKg?: number;

  @ApiProperty({ required: false })
  waistCm?: number;

  @ApiProperty({ type: [String] })
  diagnoses!: string[];

  @ApiProperty({ type: [String] })
  medications!: string[];

  @ApiProperty({ type: [String] })
  allergies!: string[];

  @ApiProperty({ required: false })
  clinicalNotes?: string;

  @ApiProperty({ description: '낙관적 잠금 버전 (§6)' })
  version!: number;
}
