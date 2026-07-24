import { ApiProperty } from '@nestjs/swagger';
import { PATIENT_SEXES } from '../request/create-patient.request.dto';
import { PATIENT_STATUSES } from '../request/list-patients.query.dto';

/** 목록용 요약 — 민감 필드(병력·약물·알레르기·노트)는 포함하지 않는다 (§6) */
export class PatientSummaryResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'CASE-001' })
  caseLabel!: string;

  @ApiProperty({ required: false, description: 'birthYear 기준 만 나이 근사' })
  age?: number;

  @ApiProperty({ required: false, enum: PATIENT_SEXES })
  sex?: string;

  @ApiProperty({ required: false, description: '소수 1자리' })
  bmi?: number;

  @ApiProperty({ enum: PATIENT_STATUSES })
  status!: (typeof PATIENT_STATUSES)[number];

  @ApiProperty({ description: 'ISO 8601' })
  updatedAt!: string;
}
