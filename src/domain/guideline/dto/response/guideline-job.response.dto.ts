import { ApiProperty } from '@nestjs/swagger';
import { GuidelineJobStatus, GuidelineJobTrigger } from '../../persistence/guideline-job.schema';

export const GUIDELINE_JOB_TRIGGERS = ['MANUAL', 'SCHEDULE'] as const;

export const GUIDELINE_JOB_STATUSES = [
  'RUNNING',
  'COMPLETED',
  'CANCELLING',
  'CANCELLED',
  'INTERRUPTED',
  'FAILED',
] as const;

/**
 * 전건 파이프라인 잡 (docs/specs/22).
 *
 * 카운터는 그 잡에 속한 `pipeline_runs`의 종결 상태를 집계한 값이다 —
 * `processed = succeeded + skipped + failed`라 진행 중(`RUNNING`)인 실행은 세지 않고
 * `INTERRUPTED`는 어느 카운터에도 들어가지 않는다.
 */
export class GuidelineJobResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    enum: GUIDELINE_JOB_STATUSES,
    description: 'POST 응답은 항상 RUNNING이다 — 생성한 행을 그대로 돌려주므로',
  })
  status!: GuidelineJobStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '잡을 시작한 ADMIN. 크론이 만든 잡(triggeredBy=SCHEDULE)은 null이다',
  })
  requestedBy!: string | null;

  @ApiProperty({
    enum: GUIDELINE_JOB_TRIGGERS,
    description: '잡을 시작한 주체 — 크론이 만들었으면 SCHEDULE (docs/specs/26)',
  })
  triggeredBy!: GuidelineJobTrigger;

  @ApiProperty({ description: '러너가 원본 목록을 받은 직후 채운다 — POST 응답 시점엔 0' })
  total!: number;

  @ApiProperty({ description: 'succeeded + skipped + failed' })
  processed!: number;

  @ApiProperty({ description: '재적재로 created=false인 실행도 포함' })
  succeeded!: number;

  @ApiProperty({ description: '첨부가 없어 파이프라인에 들어가지 못한 문서' })
  skipped!: number;

  @ApiProperty()
  failed!: number;

  @ApiProperty()
  startedAt!: string;

  @ApiProperty({ type: String, nullable: true })
  finishedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '러너 자체가 죽어 남은 문서를 시도하지 못한 경우의 사유 (status=FAILED)',
  })
  error!: string | null;
}
