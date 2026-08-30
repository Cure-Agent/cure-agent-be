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

  @ApiProperty({ type: [AnswerCitationResponseDto] })
  citations!: AnswerCitationResponseDto[];

  @ApiProperty({ description: 'ISO 8601' })
  createdAt!: string;
}
