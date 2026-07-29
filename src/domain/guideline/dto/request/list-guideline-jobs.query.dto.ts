import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** 잡 이력 조회 (docs/specs/22) — 최신순 커서 (§10.4) */
export class ListGuidelineJobsQueryDto {
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
