import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export const CONVERSATION_TYPES = ['GUIDELINE_QA', 'PATIENT_GUIDANCE'] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

export class CreateConversationRequestDto {
  @ApiProperty({ enum: CONVERSATION_TYPES, description: 'PATIENT_GUIDANCE는 9단계 활성화 예정' })
  @IsIn(CONVERSATION_TYPES)
  type!: ConversationType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  patientId?: string;

  @ApiProperty({ required: false, maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  title?: string;
}
