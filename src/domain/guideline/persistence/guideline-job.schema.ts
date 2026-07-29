/**
 * 전건 파이프라인 잡과 단계별 실행 기록 (docs/specs/22).
 *
 * `guideline_jobs` 1건이 `pipeline_runs` N건을 낳는다. `job_id`가 NULL이면 잡 밖의 단건 실행
 * (docs/specs/21의 1건 동기 pipeline, docs/specs/05의 JSON 인제스트 스크립트)이라, 1건 경로와
 * 전건 경로가 같은 기록 구조를 쓴다 — 잡 전용 항목 테이블을 따로 두면 같은 사건이 두 곳에 기록된다.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';
import { clinicians } from '../../clinician/persistence/clinician.schema';

export const guidelineJobStatus = pgEnum('guideline_job_status', [
  'RUNNING',
  'COMPLETED',
  'CANCELLING',
  'CANCELLED',
  'INTERRUPTED',
  'FAILED',
]);

export const pipelineRunStatus = pgEnum('pipeline_run_status', [
  'RUNNING',
  'SUCCEEDED',
  'SKIPPED',
  'FAILED',
  'INTERRUPTED',
]);

/** 실행이 가장 멀리 도달한 단계 — 진행·성공·실패·건너뜀·중단을 같은 축으로 읽는다 */
export const pipelineRunPhase = pgEnum('pipeline_run_phase', [
  'ACQUIRE',
  'PARSE',
  'EMBED',
  'INGEST',
]);

/**
 * 단계별 산출. 키는 **그 단계를 마쳤을 때만 생긴다** — 도달하지 못했거나 실패한 단계의 키는
 * 0으로 채우지 않고 아예 없다 (docs/specs/22).
 */
export interface PipelineRunStages {
  acquire?: { bytes: number; contentType: string; ms: number };
  /** chunks는 dedupe **전** 파서 출력 그대로다 */
  parse?: { pages: number; sections: number; chunks: number; ms: number };
  /** vectors는 임베딩을 **실제로 호출한** 청크 수 (dedupe 후 = ingest.chunks) */
  embed?: { vectors: number; model: string; ms: number };
  ingest?: { sections: number; chunks: number; skippedChunks: number; ms: number };
}

export const guidelineJobs = pgTable(
  'guideline_jobs',
  {
    id: text('id').primaryKey(), // ULID
    status: guidelineJobStatus('status').notNull().default('RUNNING'),
    requestedBy: text('requested_by')
      .notNull()
      .references(() => clinicians.id),
    /** 잡 시작 시점에 정해져 도중에 변하지 않는다 — 러너가 원본 목록을 받은 직후 채운다 */
    total: integer('total').notNull().default(0),
    /** processed = succeeded + skipped + failed. RUNNING 실행은 세지 않는다 */
    processed: integer('processed').notNull().default(0),
    succeeded: integer('succeeded').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** 러너 자체가 죽어 남은 문서를 시도하지 못한 경우의 사유 (status=FAILED) */
    error: text('error'),
    ...baseColumns,
  },
  (table) => [
    /**
     * 동시 실행 1개 강제 — 앱 메모리 플래그가 아니라 DB 제약으로 막는다 (docs/specs/22).
     * 유니크 대상이 **상수**여야 「활성 잡은 전체에서 하나」가 된다. status 컬럼에 걸면
     * RUNNING 1건 + CANCELLING 1건이 동시에 허용되어 제약이 무너진다.
     * PG17 실측: 두 번째 활성 INSERT는 23505, 같은 행의 RUNNING→CANCELLING UPDATE는 통과,
     * 부팅 정리의 일괄 UPDATE도 무충돌.
     */
    uniqueIndex('uq_guideline_jobs_active')
      .on(sql`(true)`)
      .where(sql`${table.status} IN ('RUNNING', 'CANCELLING')`),
  ],
);

export const pipelineRuns = pgTable(
  'pipeline_runs',
  {
    id: text('id').primaryKey(), // ULID
    /** NULL이면 잡 밖의 단건 실행 (docs/specs/21 동기 pipeline, docs/specs/05 스크립트) */
    jobId: text('job_id').references(() => guidelineJobs.id),
    /** 잡 안의 처리 순서. 잡 밖 실행은 0 */
    order: integer('order').notNull().default(0),
    // docs/specs/05의 JSON 인제스트 경로에는 원본 식별자가 없다
    sourceSystem: text('source_system'),
    externalId: text('external_id'),
    status: pipelineRunStatus('status').notNull().default('RUNNING'),
    phase: pipelineRunPhase('phase').notNull().default('ACQUIRE'),
    /** 실패한 **단계**로 정한다 — 던져진 예외의 타입이 아니다 (docs/specs/22) */
    errorCode: text('error_code'),
    error: text('error'),
    /** 인제스트 입력 전문 해시 — ACQUIRE·PARSE에서 끝난 실행에는 없다 */
    inputHash: text('input_hash'),
    guidelineId: text('guideline_id'),
    guidelineVersionId: text('guideline_version_id'),
    revision: integer('revision'),
    /** 새 revision을 만들었는지 — 동일 내용 재적재면 false (docs/specs/21) */
    created: boolean('created'),
    stages: jsonb('stages').$type<PipelineRunStages>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...baseColumns,
  },
  (table) => [
    // 잡 상세·스냅샷은 order 오름차순으로 읽는다 (docs/specs/22)
    index('idx_pipeline_runs_job_order').on(table.jobId, table.order),
    // "이 문서가 그동안 어떻게 처리돼 왔나" — 잡을 가로지르는 조회
    index('idx_pipeline_runs_external').on(table.externalId),
    index('idx_pipeline_runs_status').on(table.status),
  ],
);

export type GuidelineJobRow = typeof guidelineJobs.$inferSelect;
export type PipelineRunRow = typeof pipelineRuns.$inferSelect;
export type GuidelineJobStatus = (typeof guidelineJobStatus.enumValues)[number];
export type PipelineRunStatus = (typeof pipelineRunStatus.enumValues)[number];
export type PipelineRunPhase = (typeof pipelineRunPhase.enumValues)[number];
