import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const FEEDBACK_RATINGS = ['HELPFUL', 'NOT_HELPFUL'] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

export class SubmitFeedbackRequestDto {
  @ApiProperty({ enum: FEEDBACK_RATINGS })
  @IsIn(FEEDBACK_RATINGS)
  rating!: FeedbackRating;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  reasonCodes?: string[];

  @ApiProperty({ required: false, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}
