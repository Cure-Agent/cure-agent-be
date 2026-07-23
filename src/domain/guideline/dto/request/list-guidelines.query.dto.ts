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
}
