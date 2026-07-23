import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, Length, ValidateNested } from 'class-validator';

export class GuidelineSearchFilterDto {
  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  guidelineIds?: string[];

  @ApiProperty({ required: false, type: [String], description: '권고등급 code 목록' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  recommendationGrades?: string[];

  @ApiProperty({ required: false, type: [String], description: '근거수준 code 목록' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  evidenceLevels?: string[];
}

export class SendMessageRequestDto {
  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @Length(1, 4000)
  content!: string;

  @ApiProperty({ required: false, type: GuidelineSearchFilterDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GuidelineSearchFilterDto)
  filters?: GuidelineSearchFilterDto;

  @ApiProperty({ description: '중복 생성 방지 키 — 재시도 시 같은 값 사용 (§8 복구 계약)' })
  @IsString()
  @Length(1, 100)
  clientRequestId!: string;
}
