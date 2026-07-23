import { ApiProperty } from '@nestjs/swagger';

/** §7 AnswerCitationResponseDto — 답변 텍스트의 [marker]가 가리키는 근거. */
export class AnswerCitationResponseDto {
  @ApiProperty({ description: '답변 내 인용 마커 번호' })
  marker!: number;

  @ApiProperty({ description: 'EvidenceChunk id — GET /evidence/{id}로 원문 조회' })
  evidenceId!: string;

  @ApiProperty()
  guidelineTitle!: string;

  @ApiProperty()
  guidelineVersion!: string;

  @ApiProperty({ type: [String] })
  sectionPath!: string[];

  @ApiProperty({ description: '인용 발췌' })
  quote!: string;

  @ApiProperty()
  sourceUrl!: string;
}
