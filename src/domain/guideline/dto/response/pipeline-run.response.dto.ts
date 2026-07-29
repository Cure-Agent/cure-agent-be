import { ApiProperty } from '@nestjs/swagger';
import {
  PipelineRunPhase,
  PipelineRunStatus,
} from '../../persistence/guideline-job.schema';

export const PIPELINE_RUN_STATUSES = [
  'RUNNING',
  'SUCCEEDED',
  'SKIPPED',
  'FAILED',
  'INTERRUPTED',
] as const;

export const PIPELINE_RUN_PHASES = ['ACQUIRE', 'PARSE', 'EMBED', 'INGEST'] as const;

export class PipelineStageAcquireDto {
  @ApiProperty({ description: '받은 본문 크기' })
  bytes!: number;

  @ApiProperty()
  contentType!: string;

  @ApiProperty()
  ms!: number;
}

export class PipelineStageParseDto {
  @ApiProperty()
  pages!: number;

  @ApiProperty()
  sections!: number;

  @ApiProperty({ description: 'dedupe **전** 파서 출력 그대로' })
  chunks!: number;

  @ApiProperty()
  ms!: number;
}

export class PipelineStageEmbedDto {
  @ApiProperty({ description: '임베딩을 실제로 호출한 청크 수 (dedupe 후)' })
  vectors!: number;

  @ApiProperty({ example: 'fake-embedding-v1' })
  model!: string;

  @ApiProperty()
  ms!: number;
}

export class PipelineStageIngestDto {
  @ApiProperty()
  sections!: number;

  @ApiProperty()
  chunks!: number;

  @ApiProperty({ description: '버전 내 중복 콘텐츠로 건너뛴 청크 수' })
  skippedChunks!: number;

  @ApiProperty()
  ms!: number;
}

/**
 * 단계별 산출 (docs/specs/22).
 * **키는 그 단계를 마쳤을 때만 생긴다** — 도달하지 못했거나 실패한 단계의 키는 0으로 채우지
 * 않고 아예 없다. `SKIPPED`는 `{acquire}`, EMBED 실패는 `{acquire, parse}`,
 * `created=false`는 임베딩을 호출하지 않으므로 `{acquire, parse, ingest}`다.
 */
export class PipelineRunStagesDto {
  @ApiProperty({ type: PipelineStageAcquireDto, required: false })
  acquire?: PipelineStageAcquireDto;

  @ApiProperty({ type: PipelineStageParseDto, required: false })
  parse?: PipelineStageParseDto;

  @ApiProperty({ type: PipelineStageEmbedDto, required: false })
  embed?: PipelineStageEmbedDto;

  @ApiProperty({ type: PipelineStageIngestDto, required: false })
  ingest?: PipelineStageIngestDto;
}

/**
 * 문서 1건의 수집→파싱→임베딩→적재 실행 기록 (docs/specs/22).
 *
 * SSE 스트림(`run.stage`)과 `GET /admin/pipeline-runs`가 **같은 DTO를 공유한다** —
 * 둘은 대체재가 아니라 시간 축이 다른 같은 데이터다(스트림은 지금, 목록은 그동안).
 */
export class PipelineRunResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null이면 잡 밖의 단건 실행 (docs/specs/21 동기 pipeline, docs/specs/05 스크립트)',
  })
  jobId!: string | null;

  @ApiProperty({ description: '잡 안의 처리 순서. 잡 밖 실행은 0' })
  order!: number;

  @ApiProperty({ type: String, nullable: true, example: 'NCKM' })
  sourceSystem!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '325' })
  externalId!: string | null;

  @ApiProperty({ enum: PIPELINE_RUN_STATUSES })
  status!: PipelineRunStatus;

  @ApiProperty({ enum: PIPELINE_RUN_PHASES, description: '가장 멀리 도달한 단계' })
  phase!: PipelineRunPhase;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '실패한 **단계**로 정한다 — 던져진 예외의 타입이 아니다',
  })
  errorCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  error!: string | null;

  @ApiProperty({ type: String, nullable: true })
  guidelineId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  guidelineVersionId!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  revision!: number | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: '새 revision을 만들었는가 — 동일 contentHash 재적재면 false (docs/specs/21)',
  })
  created!: boolean | null;

  @ApiProperty({ type: PipelineRunStagesDto })
  stages!: PipelineRunStagesDto;

  @ApiProperty()
  startedAt!: string;

  @ApiProperty({ type: String, nullable: true })
  finishedAt!: string | null;
}
