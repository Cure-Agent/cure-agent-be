import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';
import { CreatePatientRequestDto } from './create-patient.request.dto';

/** partial 수정 + 낙관적 잠금 (§6) — version 불일치는 409 PATIENT_VERSION_CONFLICT */
export class UpdatePatientRequestDto extends PartialType(CreatePatientRequestDto) {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}
