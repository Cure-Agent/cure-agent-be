import { ApiProperty } from '@nestjs/swagger';
import { RatingResponseDto } from './rating.response.dto';

/** §7 EvidenceDetailResponseDto 계약 그대로. */
export class EvidenceDetailResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  guidelineId!: string;

  @ApiProperty()
  guidelineVersionId!: string;

  @ApiProperty()
  guidelineTitle!: string;

  @ApiProperty({ example: '1.0' })
  version!: string;

  @ApiProperty({ type: [String] })
  sectionPath!: string[];

  @ApiProperty({ required: false })
  recommendationNumber?: string;

  @ApiProperty({ required: false, description: '권고문 원문 (권고 청크인 경우)' })
  recommendationText?: string;

  @ApiProperty({ type: RatingResponseDto, required: false })
  recommendationGrade?: RatingResponseDto;

  @ApiProperty({ type: RatingResponseDto, required: false })
  evidenceLevel?: RatingResponseDto;

  @ApiProperty({ description: '본문 발췌 전문' })
  excerpt!: string;

  @ApiProperty({ required: false })
  pageStart?: number;

  @ApiProperty({ required: false })
  pageEnd?: number;

  @ApiProperty()
  sourceUrl!: string;
}
