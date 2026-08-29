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

  /**
   * `quote`의 번역 (docs/specs/42). `quote`가 청크 원문의 앞 120자 기계 절단이므로
   * (`conversation-stream.service.ts` QUOTE_LIMIT), 청크 번역을 같은 방식으로 잘라 만든다 —
   * 한국어 120자를 영어로 옮기면 대략 두 배가 되므로 영문 상한은 240이다(기준 13).
   * `quote`(한국어)는 번역 유무와 무관하게 항상 실린다 — §7의 「원문 대조 최소 집합」(기준 17).
   */
  @ApiProperty({ required: false, description: '인용 발췌의 번역 (기계 번역)' })
  quoteTranslated?: string;

  @ApiProperty({ required: false, description: '지침 제목의 번역 (기계 번역)' })
  titleTranslated?: string;
}
