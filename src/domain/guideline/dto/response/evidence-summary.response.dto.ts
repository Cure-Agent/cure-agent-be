import { ApiProperty } from '@nestjs/swagger';
import { RatingResponseDto } from './rating.response.dto';

export class EvidenceSummaryResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ type: [String], example: ['2', '치료', '침치료'] })
  sectionPath!: string[];

  @ApiProperty({ required: false, example: 'R1' })
  recommendationNumber?: string;

  @ApiProperty({ description: '본문 발췌 (200자 축약)' })
  excerpt!: string;

  @ApiProperty({ type: RatingResponseDto, required: false })
  recommendationGrade?: RatingResponseDto;

  @ApiProperty({ type: RatingResponseDto, required: false })
  evidenceLevel?: RatingResponseDto;
}
