import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  PipelineRunPhase,
  PipelineRunStatus,
} from '../../persistence/guideline-job.schema';
import {
  PIPELINE_RUN_PHASES,
  PIPELINE_RUN_STATUSES,
} from '../response/pipeline-run.response.dto';

/**
 * 단계별 실행 이력 조회 (docs/specs/22).
 *
 * 잡에 속하지 않은 실행(§21의 1건 동기 호출, §05 JSON 인제스트 스크립트)까지 한 자리에서
 * 보는 것이 이 목록의 존재 이유다. 정렬은 항상 최신순이며 어떤 필터를 걸어도 바뀌지 않는다.
 */
export class ListPipelineRunsQueryDto {
  @ApiProperty({ required: false, description: '특정 잡의 실행만' })
  @IsOptional()
  @IsString()
  jobId?: string;

  @ApiProperty({
    required: false,
    example: '325',
    description: '이 문서가 그동안 어떻게 처리돼 왔나 — 잡을 가로지르는 조회',
  })
  @IsOptional()
  @IsString()
  externalId?: string;

  @ApiProperty({ required: false, enum: PIPELINE_RUN_STATUSES })
  @IsOptional()
  @IsIn(PIPELINE_RUN_STATUSES)
  status?: PipelineRunStatus;

  @ApiProperty({ required: false, enum: PIPELINE_RUN_PHASES })
  @IsOptional()
  @IsIn(PIPELINE_RUN_PHASES)
  phase?: PipelineRunPhase;

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
