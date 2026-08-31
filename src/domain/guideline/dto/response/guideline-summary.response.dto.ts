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

  /**
   * `title`의 번역 (docs/specs/44) — 원천은 `evidence_chunk_translations.title_translated`로
   * §42가 이미 「제목 번역의 원천」이라 부른 컬럼이다(새 컬럼 0). 청크 번역이 없는 지침은
   * **키 부재로 닫혀** 원문 제목이 표시된다.
   */
  @ApiProperty({ required: false, description: '지침 제목의 번역 (기계 번역)' })
  titleTranslated?: string;
}
