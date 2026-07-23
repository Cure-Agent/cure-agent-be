import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CONVERSATION_TYPES, ConversationType } from './create-conversation.request.dto';

export class ListConversationsQueryDto {
  @ApiProperty({ required: false, enum: CONVERSATION_TYPES })
  @IsOptional()
  @IsIn(CONVERSATION_TYPES)
  type?: ConversationType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  patientId?: string;

  @ApiProperty({ required: false, description: '불투명 커서 (§10.4)' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  size?: number;
}
