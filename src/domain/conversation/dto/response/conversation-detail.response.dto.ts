import { ApiProperty } from '@nestjs/swagger';
import { ConversationSummaryResponseDto } from './conversation-summary.response.dto';

export class ConversationDetailResponseDto extends ConversationSummaryResponseDto {
  @ApiProperty({ description: 'ISO 8601' })
  createdAt!: string;
}
