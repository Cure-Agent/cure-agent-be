import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, Length, ValidateNested } from 'class-validator';

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

  /**
   * 답변을 쓸 언어 (docs/specs/42). **FE가 입력 언어에서 유도해 실어 보낸다** — UI 언어가
   * 아니다. 미지정이면 `ko`로 처리해 기존 클라이언트의 형태를 유지한다(기준 3).
   */
  @ApiProperty({ required: false, enum: ['ko', 'en'], default: 'ko' })
  @IsOptional()
  @IsIn(['ko', 'en'])
  responseLang?: 'ko' | 'en';
}
