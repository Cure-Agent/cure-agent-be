import { ApiProperty } from '@nestjs/swagger';

export const GUIDELINE_STATUSES = ['ACTIVE', 'SUPERSEDED'] as const;
export type GuidelineStatus = (typeof GUIDELINE_STATUSES)[number];

export class GuidelineSummaryResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: '요통 한의표준임상진료지침' })
  title!: string;

  @ApiProperty({ example: '한국한의약진흥원' })
  publisher!: string;

  @ApiProperty({ example: '1.0' })
  currentVersion!: string;

  @ApiProperty({ description: '현재 버전 발행일 (ISO 8601)' })
  publishedAt!: string;

  @ApiProperty({ enum: GUIDELINE_STATUSES })
  status!: GuidelineStatus;
}
