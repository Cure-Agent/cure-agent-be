import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { GUIDELINE_STATUSES, GuidelineStatus } from '../response/guideline-summary.response.dto';

export class ListGuidelinesQueryDto {
  @ApiProperty({ required: false, description: '제목 부분일치 검색' })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiProperty({ required: false, enum: GUIDELINE_STATUSES })
  @IsOptional()
  @IsIn(GUIDELINE_STATUSES)
  status?: GuidelineStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  publisher?: string;

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

  /**
   * 목록 제목을 실을 언어 (docs/specs/44). 지침 탐색기에는 대화 맥락이 없으므로 **화면이
   * UI 토글을 싣는다** — 채팅 안의 근거와 달리 「저장된 언어」가 없다. 미지정이면 `ko`라
   * 기존 클라이언트의 형태가 그대로 유지된다.
   */
  @ApiProperty({ required: false, enum: ['ko', 'en'], default: 'ko' })
  @IsOptional()
  @IsIn(['ko', 'en'])
  lang?: 'ko' | 'en';
}
