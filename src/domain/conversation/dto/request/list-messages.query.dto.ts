import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListMessagesQueryDto {
  @ApiProperty({ required: false, description: '불투명 커서 (§10.4)' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({
    required: false,
    enum: ['asc', 'desc'],
    default: 'asc',
    description: 'desc면 최신부터 역방향 조회 — cursor는 이전 페이지 마지막 메시지보다 과거 경계',
  })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @ApiProperty({ required: false, default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size?: number;
}
