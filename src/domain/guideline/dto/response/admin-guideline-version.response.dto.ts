import { ApiProperty } from '@nestjs/swagger';

export const GUIDELINE_VERSION_STATUSES = ['ACTIVE', 'SUPERSEDED'] as const;
export type GuidelineVersionStatus = (typeof GUIDELINE_VERSION_STATUSES)[number];

export class AdminGuidelineVersionResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: '2024-07', description: '원문 판본' })
  version!: string;

  @ApiProperty({ example: 2, description: '같은 판본을 다시 파싱한 처리 회차' })
  revision!: number;

  @ApiProperty({ enum: GUIDELINE_VERSION_STATUSES })
  status!: GuidelineVersionStatus;

  @ApiProperty({ description: '발행일 (ISO 8601)' })
  publishedAt!: string;

  @ApiProperty({ description: '인제스트 입력 전문 해시 — 재적재 변경 감지 기준' })
  contentHash!: string;

  @ApiProperty({ example: 152, description: '이 버전에 적재된 근거 청크 수' })
  chunkCount!: number;
}
