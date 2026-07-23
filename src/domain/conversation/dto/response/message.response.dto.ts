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

  @ApiProperty({ type: [AnswerCitationResponseDto] })
  citations!: AnswerCitationResponseDto[];

  @ApiProperty({ description: 'ISO 8601' })
  createdAt!: string;
}
