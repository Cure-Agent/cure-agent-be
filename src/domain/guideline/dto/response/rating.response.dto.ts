import { ApiProperty } from '@nestjs/swagger';

/** 권고등급·근거수준 — 문서마다 체계가 달라 enum으로 고정하지 않는다 (architecture.md §7). */
export class RatingResponseDto {
  @ApiProperty({ example: 'GRADE' })
  system!: string;

  @ApiProperty({ example: 'A' })
  code!: string;

  @ApiProperty({ example: '강한 권고' })
  label!: string;
}
