import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * 1건 수집→파싱→적재 (docs/specs/21).
 * 전건 일괄은 잡·진행 스트림이 필요해 별도 spec이다 — 여기는 문서 1건만 받는다.
 */
export class RunPipelineRequestDto {
  @ApiProperty({ example: '325', description: 'NCKM 문서 식별자 (guide_idx)' })
  @IsString()
  @IsNotEmpty()
  guideIdx!: string;
}
