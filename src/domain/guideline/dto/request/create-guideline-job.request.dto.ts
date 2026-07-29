import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString } from 'class-validator';

/** 전건 잡 대상 문서 수 상한 — 원본 목록이 86건이라 넉넉히 잡는다 */
const MAX_EXTERNAL_IDS = 500;

/**
 * 전건 파이프라인 잡 시작 (docs/specs/22).
 *
 * 원본 목록에 없는 `externalId`가 섞여 있어도 거절하지 않는다 — 그 문서는
 * `FAILED`·`phase=ACQUIRE`·`errorCode=NOT_FOUND` 실행 행으로 남고 잡은 계속 돈다.
 */
export class CreateGuidelineJobRequestDto {
  @ApiProperty({
    required: false,
    type: [String],
    example: ['325', '326'],
    description: '생략하면 원본 목록 전건. 실패한 문서만 다시 돌리는 것이 이 필드의 용도다',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EXTERNAL_IDS)
  @IsString({ each: true })
  externalIds?: string[];
}
