import { ApiProperty } from '@nestjs/swagger';

/** 커서 기반 페이지 메타 (architecture.md §10.4) — totalCount는 계약에 없다. */
export class PageMetaDto {
  @ApiProperty({ description: '이번 페이지 항목 수' })
  size!: number;

  @ApiProperty({ description: '다음 페이지 존재 여부' })
  hasNext!: boolean;

  @ApiProperty({ type: String, nullable: true, description: '다음 페이지 커서(불투명 문자열)' })
  nextCursor!: string | null;
}
