import { ApiProperty } from '@nestjs/swagger';
import { AnswerCitationResponseDto } from './answer-citation.response.dto';

export const MESSAGE_STATUSES = [
  'STREAMING',
  'COMPLETED',
  'ABSTAINED',
  'FAILED',
  'CANCELLED',
] as const;
export const MESSAGE_ROLES = ['USER', 'ASSISTANT'] as const;
export const ANSWER_KINDS = ['GUIDELINE_ANSWER', 'CLINICAL_GUIDANCE'] as const;

export class MessageResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: MESSAGE_ROLES })
  role!: (typeof MESSAGE_ROLES)[number];

  @ApiProperty()
  content!: string;

  @ApiProperty({ enum: MESSAGE_STATUSES })
  status!: (typeof MESSAGE_STATUSES)[number];

  @ApiProperty({ enum: ANSWER_KINDS, required: false })
  answerKind?: (typeof ANSWER_KINDS)[number];

  @ApiProperty({
    required: false,
    description: 'CLINICAL_GUIDANCE 답변의 임상 참고안 id — GET /clinical-guidance/{id}로 조회',
  })
  guidanceId?: string;

  @ApiProperty({
    required: false,
    description:
      '기권 사유 안내 문장 — ABSTAINED 메시지에만 실린다. 사유가 기록되지 않은 과거 메시지는 이 키가 빠진다',
  })
  abstainReason?: string;

  /**
   * 이 메시지가 실제로 답한 언어 (docs/specs/44) — **화면 표시 언어의 원천이다.**
   *
   * 재조회에는 질의도 요청 언어도 실리지 않으므로, 이것 없이는 대화 목록에 갔다 돌아온 화면이
   * 그 메시지의 언어를 알 방법이 없다. 컬럼(`messages.response_lang`)이 이미 있고 기본값이
   * `'ko'`라, 언어를 보내지 않고 만든 과거 메시지는 `ko`로 읽힌다(§42 기준 3 계승).
   */
  @ApiProperty({ enum: ['ko', 'en'], required: false, description: '이 메시지가 답한 언어' })
  responseLang?: 'ko' | 'en';

  @ApiProperty({ type: [AnswerCitationResponseDto] })
  citations!: AnswerCitationResponseDto[];

  @ApiProperty({ description: 'ISO 8601' })
  createdAt!: string;
}
