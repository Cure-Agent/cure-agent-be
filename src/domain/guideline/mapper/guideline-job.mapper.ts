import { GuidelineJobResponseDto } from '../dto/response/guideline-job.response.dto';
import { PipelineRunResponseDto } from '../dto/response/pipeline-run.response.dto';
import { GuidelineJobRow, PipelineRunRow } from '../persistence/guideline-job.schema';

export function toGuidelineJob(row: GuidelineJobRow): GuidelineJobResponseDto {
  return {
    id: row.id,
    status: row.status,
    requestedBy: row.requestedBy,
    triggeredBy: row.triggeredBy,
    total: row.total,
    processed: row.processed,
    succeeded: row.succeeded,
    skipped: row.skipped,
    failed: row.failed,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    error: row.error,
  };
}

/**
 * 스트림(`run.stage`)과 `GET /admin/pipeline-runs`가 같은 DTO를 공유한다 —
 * 둘은 대체재가 아니라 시간 축이 다른 같은 데이터다 (docs/specs/22).
 */
export function toPipelineRun(row: PipelineRunRow): PipelineRunResponseDto {
  return {
    id: row.id,
    jobId: row.jobId,
    order: row.order,
    sourceSystem: row.sourceSystem,
    externalId: row.externalId,
    status: row.status,
    phase: row.phase,
    errorCode: row.errorCode,
    error: row.error,
    guidelineId: row.guidelineId,
    guidelineVersionId: row.guidelineVersionId,
    revision: row.revision,
    created: row.created,
    // 마친 단계의 키만 들어 있다 — 도달하지 못한 단계는 0으로 채우지 않고 아예 없다
    stages: row.stages,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
