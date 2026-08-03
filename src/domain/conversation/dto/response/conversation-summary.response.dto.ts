import { ApiProperty } from '@nestjs/swagger';
import { CONVERSATION_TYPES } from '../request/create-conversation.request.dto';
import { CONVERSATION_STATUSES } from '../request/list-conversations.query.dto';

export class ConversationSummaryResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: CONVERSATION_TYPES })
  type!: (typeof CONVERSATION_TYPES)[number];

  @ApiProperty()
  title!: string;

  @ApiProperty({ enum: CONVERSATION_STATUSES, description: '보관 여부 (docs/specs/11 additive)' })
  status!: (typeof CONVERSATION_STATUSES)[number];

  @ApiProperty({ required: false, description: '마지막 메시지 미리보기 (80자)' })
  lastMessagePreview?: string;

  @ApiProperty({
    description:
      '마지막 메시지 시각 (메시지가 없으면 대화 생성 시각) — 목록 정렬 키다. ISO 8601',
  })
  lastMessageAt!: string;
}
