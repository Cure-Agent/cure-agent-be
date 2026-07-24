import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const PATIENT_SEXES = ['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'] as const;
export type PatientSex = (typeof PATIENT_SEXES)[number];

export class CreatePatientRequestDto {
  @ApiProperty({ example: 'CASE-001', description: '비식별 케이스 라벨 (§4.5)' })
  @IsString()
  @Length(1, 50)
  caseLabel!: string;

  @ApiProperty({ required: false, example: 1980 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2100)
  birthYear?: number;

  @ApiProperty({ required: false, enum: PATIENT_SEXES })
  @IsOptional()
  @IsIn(PATIENT_SEXES)
  sex?: PatientSex;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(30)
  @Max(300)
  heightCm?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(500)
  weightKg?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(20)
  @Max(300)
  waistCm?: number;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  diagnoses!: string[];

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  medications!: string[];

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  allergies!: string[];

  @ApiProperty({ required: false, maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  clinicalNotes?: string;
}
