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

  /**
   * `sectionPath`의 번역 (docs/specs/44) — 원문과 **같은 길이의 배열**이다.
   * 저장된 인용도 펼침 헤더를 그리므로, 세 경로(`EvidenceDetail`·여기·`GuidanceCitationJson`)
   * 가운데 하나라도 비면 그 화면만 한국어로 남는다.
   */
  @ApiProperty({ required: false, type: [String], description: '섹션 경로의 번역 (기계 번역)' })
  sectionPathTranslated?: string[];
}
