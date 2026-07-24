import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/** §5.7 대화명 변경 — docs/specs/11로 §6에 확정 편입 */
export class UpdateConversationRequestDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @Length(1, 100)
  title!: string;
}
