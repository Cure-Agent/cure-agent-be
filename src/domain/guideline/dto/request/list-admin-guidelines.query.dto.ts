import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * 관리 목록 조회 (docs/specs/21).
 * 공개 목록(`ListGuidelinesQueryDto`)과 달리 status 필터가 없다 —
 * 폐기된 버전을 찾는 것이 이 화면의 목적이므로 전부 보여준다.
 */
export class ListAdminGuidelinesQueryDto {
  @ApiProperty({ required: false, description: '제목 부분일치 검색' })
  @IsOptional()
  @IsString()
  query?: string;

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
