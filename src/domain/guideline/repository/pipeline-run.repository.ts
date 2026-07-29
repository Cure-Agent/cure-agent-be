import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import {
  PipelineRunPhase,
  PipelineRunRow,
  PipelineRunStages,
  PipelineRunStatus,
  pipelineRuns,
} from '../persistence/guideline-job.schema';

export interface PipelineRunInsert {
  id: string;
  /** null이면 잡 밖의 단건 실행 (docs/specs/21 동기 pipeline, docs/specs/05 스크립트) */
  jobId: string | null;
  /** 잡 안의 처리 순서. 잡 밖 실행은 0 */
  order: number;
  sourceSystem: string | null;
  externalId: string | null;
}

/** 종결 시 한 번에 기록하는 값들. 도달하지 못한 단계의 필드는 넘기지 않는다 */
export interface PipelineRunFinalizeInput {
  status: PipelineRunStatus;
  /** 가장 멀리 도달한 단계 — 생략하면 마지막으로 기록된 phase를 그대로 둔다 */
  phase?: PipelineRunPhase;
  errorCode?: string | null;
  error?: string | null;
  inputHash?: string | null;
  guidelineId?: string | null;
  guidelineVersionId?: string | null;
  revision?: number | null;
  created?: boolean | null;
  /** 마지막 단계 산출 — 기존 키에 병합된다 */
  stages?: Partial<PipelineRunStages>;
}

export interface ListPipelineRunsFilter {
  jobId?: string;
  externalId?: string;
  status?: PipelineRunStatus;
  phase?: PipelineRunPhase;
  afterId?: string; // 커서 (id desc 순서)
  /** hasNext 판정을 위해 호출측이 size+1을 넘긴다 (guideline.repository.ts와 같은 관례) */
  limit: number;
}

/** 단계별 실행 기록 저장소 (docs/specs/22) — Drizzle 구현 단일 클래스 (§3) */
@Injectable()
export class PipelineRunRepository {
  constructor(private readonly txManager: TransactionManager) {}

  /**
   * 문서를 **시작할 때** RUNNING 행을 만든다 — 끝날 때 한 번 쓰면 처리 도중 죽은 그 문서만
   * 기록이 없어져 「어디까지 갔나」가 남지 않는다 (docs/specs/22). status·phase·stages는
   * 스키마 기본값(RUNNING·ACQUIRE·{})을 그대로 쓴다.
   */
  async insertRunning(row: PipelineRunInsert): Promise<PipelineRunRow> {
    const rows = await this.txManager.conn.insert(pipelineRuns).values(row).returning();
    return rows[0];
  }

  /**
   * 단계 진입·완료 기록. `stages`는 **키 하나를 병합**한다 (`||` jsonb 연산자) —
   * 객체를 통째로 SET 하면 앞 단계 산출(acquire·parse…)이 사라진다. 러너는 단계마다 이 메서드를
   * 부르고 그 결과가 그대로 `run.stage` 이벤트의 payload가 된다.
   */
  async updateStage(
    runId: string,
    input: { phase: PipelineRunPhase; stages?: Partial<PipelineRunStages> },
  ): Promise<PipelineRunRow | null> {
    const rows = await this.txManager.conn
      .update(pipelineRuns)
      .set({
        phase: input.phase,
        stages: input.stages ? mergeStages(input.stages) : undefined,
      })
      .where(eq(pipelineRuns.id, runId))
      .returning();
    return rows[0] ?? null;
  }

  /** 종결 기록. 넘기지 않은 필드는 그대로 둔다 (drizzle이 undefined 키를 SET에서 제외한다) */
  async finalizeRun(
    runId: string,
    input: PipelineRunFinalizeInput,
  ): Promise<PipelineRunRow | null> {
    const rows = await this.txManager.conn
      .update(pipelineRuns)
      .set({
        status: input.status,
        phase: input.phase,
        errorCode: input.errorCode,
        error: input.error,
        inputHash: input.inputHash,
        guidelineId: input.guidelineId,
        guidelineVersionId: input.guidelineVersionId,
        revision: input.revision,
        created: input.created,
        stages: input.stages ? mergeStages(input.stages) : undefined,
        finishedAt: new Date(),
      })
      .where(eq(pipelineRuns.id, runId))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * 잡 상세·`job.snapshot`에 중첩되는 실행 — **order 오름차순**이다 (docs/specs/22).
   * 스냅샷 뒤에 이어지는 `run.stage`가 같은 진행 순서라, 클라이언트가 스냅샷 배열에 이벤트를
   * 그대로 이어붙일 수 있어야 한다.
   */
  async listByJobId(jobId: string): Promise<PipelineRunRow[]> {
    return this.txManager.conn
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.jobId, jobId))
      .orderBy(asc(pipelineRuns.order), asc(pipelineRuns.id));
  }

  /**
   * 단계별 실행 이력 — 항상 **최신순**(id ULID 내림차순)이며 어떤 필터를 걸어도 정렬 축은
   * 바뀌지 않는다 (docs/specs/22 기준 13). jobId 필터가 없으면 잡 밖 실행까지 함께 나온다.
   */
  async listByCursor(filter: ListPipelineRunsFilter): Promise<PipelineRunRow[]> {
    const conditions = [
      filter.jobId ? eq(pipelineRuns.jobId, filter.jobId) : undefined,
      filter.externalId ? eq(pipelineRuns.externalId, filter.externalId) : undefined,
      filter.status ? eq(pipelineRuns.status, filter.status) : undefined,
      filter.phase ? eq(pipelineRuns.phase, filter.phase) : undefined,
      filter.afterId ? lt(pipelineRuns.id, filter.afterId) : undefined,
    ].filter((c) => c !== undefined);

    return this.txManager.conn
      .select()
      .from(pipelineRuns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(pipelineRuns.id))
      .limit(filter.limit);
  }

  /**
   * 부팅 시 정리 (docs/specs/22 기준 11). **phase는 건드리지 않는다** — 죽은 시점의 단계를
   * 보존해야 「324 / EMBED / INTERRUPTED」처럼 어디서 멈췄는지가 남는다.
   */
  async sweepInterrupted(): Promise<number> {
    const rows = await this.txManager.conn
      .update(pipelineRuns)
      .set({ status: 'INTERRUPTED', finishedAt: new Date() })
      .where(eq(pipelineRuns.status, 'RUNNING'))
      .returning({ id: pipelineRuns.id });
    return rows.length;
  }
}

/** `stages = stages || $1::jsonb` — 기존 키를 보존하며 준 키만 덮어쓴다 */
function mergeStages(patch: Partial<PipelineRunStages>) {
  return sql`${pipelineRuns.stages} || ${JSON.stringify(patch)}::jsonb`;
}
