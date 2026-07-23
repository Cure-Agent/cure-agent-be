import { ApiProperty } from '@nestjs/swagger';
import { CONVERSATION_TYPES } from '../request/create-conversation.request.dto';

export class ConversationSummaryResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: CONVERSATION_TYPES })
  type!: (typeof CONVERSATION_TYPES)[number];

  @ApiProperty()
  title!: string;

  @ApiProperty({ required: false, description: '마지막 메시지 미리보기 (80자)' })
  lastMessagePreview?: string;

  @ApiProperty({ description: 'ISO 8601' })
  updatedAt!: string;
}
