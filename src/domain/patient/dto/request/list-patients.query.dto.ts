import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const PATIENT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type PatientStatus = (typeof PATIENT_STATUSES)[number];

export class ListPatientsQueryDto {
  @ApiProperty({ required: false, description: 'caseLabel 부분일치 검색' })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiProperty({ required: false, enum: PATIENT_STATUSES })
  @IsOptional()
  @IsIn(PATIENT_STATUSES)
  status?: PatientStatus;

  @ApiProperty({ required: false, description: '불투명 커서 (§10.4)' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  size?: number;
}
