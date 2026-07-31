import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import {
  GuidelineJobRow,
  GuidelineJobStatus,
  guidelineJobs,
} from '../persistence/guideline-job.schema';

/** 「실행 중」의 정의 — partial unique index·부팅 시 정리·cancel 판정이 모두 이 집합을 쓴다 (docs/specs/22) */
export const ACTIVE_GUIDELINE_JOB_STATUSES: GuidelineJobStatus[] = ['RUNNING', 'CANCELLING'];

/** 동시 실행 1개를 강제하는 partial unique index 이름 (guideline-job.schema.ts) */
export const ACTIVE_GUIDELINE_JOB_INDEX = 'uq_guideline_jobs_active';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * 활성 잡 중복 INSERT인지 판정한다 — 호출측이 409 `GUIDELINE_JOB_ALREADY_RUNNING`으로 변환한다.
 *
 * `code`만 보면 이 테이블의 다른 unique 위반(향후 추가될 수 있다)까지 409로 뭉개진다.
 * Postgres는 unique **인덱스** 위반에도 `constraint`에 인덱스 이름을 실어주므로 둘 다 확인한다.
 * (선례: conversation-stream.service.ts의 23505 → DUPLICATE_CLIENT_REQUEST 변환)
 */
export function isActiveGuidelineJobConflict(error: unknown): boolean {
  // drizzle이 드라이버 오류를 DrizzleQueryError로 감싸므로 code·constraint가 최상위에 없다 —
  // cause 체인을 훑는다. 감싸는 계층이 늘어도 판정이 조용히 무너지지 않는다.
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (
      candidate.code === PG_UNIQUE_VIOLATION &&
      candidate.constraint === ACTIVE_GUIDELINE_JOB_INDEX
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export interface ListGuidelineJobsFilter {
  afterId?: string; // 커서 (id desc 순서)
  /** hasNext 판정을 위해 호출측이 size+1을 넘긴다 (guideline.repository.ts와 같은 관례) */
  limit: number;
}

/** processed = succeeded + skipped + failed 이므로 증분 대상은 이 셋뿐이다 (docs/specs/22) */
export type GuidelineJobCounter = 'succeeded' | 'skipped' | 'failed';

export interface GuidelineJobFinalizeInput {
  status: GuidelineJobStatus;
  error?: string | null;
}

/** 전건 파이프라인 잡 저장소 (docs/specs/22) — Drizzle 구현 단일 클래스 (§3) */
@Injectable()
export class GuidelineJobRepository {
  constructor(private readonly txManager: TransactionManager) {}

  /**
   * 잡 생성. status·카운터는 스키마 기본값(RUNNING·0)을 그대로 쓴다 — POST 응답이 곧 이 행이다.
   *
   * 활성 잡이 이미 있으면 드라이버의 23505를 **그대로 전파한다.** 여기서 삼켜 null을 돌려주면
   * 「제약으로 막는다」는 결정이 앱 코드의 판단으로 바뀐다. 호출측은
   * `isActiveGuidelineJobConflict`로 판정한다.
   */
  async insert(
    row: Pick<GuidelineJobRow, 'id' | 'requestedBy'> &
      // 크론이 만든 잡은 requestedBy가 null이고 triggeredBy가 SCHEDULE이다 (docs/specs/26)
      Partial<Pick<GuidelineJobRow, 'triggeredBy'>>,
  ): Promise<GuidelineJobRow> {
    const rows = await this.txManager.conn.insert(guidelineJobs).values(row).returning();
    return rows[0];
  }

  async findById(id: string): Promise<GuidelineJobRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(guidelineJobs)
      .where(eq(guidelineJobs.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 잡 이력 — 최신순(id ULID 내림차순) 커서 페이지네이션 (docs/specs/22 기준 14) */
  async listByCursor(filter: ListGuidelineJobsFilter): Promise<GuidelineJobRow[]> {
    return this.txManager.conn
      .select()
      .from(guidelineJobs)
      .where(filter.afterId ? lt(guidelineJobs.id, filter.afterId) : undefined)
      .orderBy(desc(guidelineJobs.id))
      .limit(filter.limit);
  }

  /** 러너가 원본 목록을 받은 직후 1회. total은 이후 변하지 않는다 */
  async setTotal(jobId: string, total: number): Promise<void> {
    await this.txManager.conn
      .update(guidelineJobs)
      .set({ total })
      .where(eq(guidelineJobs.id, jobId));
  }

  /**
   * 종결된 실행 1건을 카운터에 반영한다.
   *
   * 읽고-쓰기로 하면 러너의 다음 문서·cancel 요청과 경합해 카운트가 어긋나므로 **SQL 표현식으로
   * 원자적 증분**한다. `processed`는 별도로 +1 하지 않고 명세의 산식
   * (`processed = succeeded + skipped + failed`)을 그대로 계산한다 — UPDATE의 우변은 전부 갱신 전
   * 값을 보므로, 증분 대상 컬럼에만 +1을 얹으면 합이 정확히 맞는다. 산식을 한 곳에만 두는 셈이라
   * 카운터가 늘어도 어긋날 여지가 없다.
   */
  async incrementCounter(jobId: string, counter: GuidelineJobCounter): Promise<void> {
    await this.txManager.conn
      .update(guidelineJobs)
      .set({
        // undefined인 키는 drizzle이 SET에서 제외한다 — 지정한 카운터 하나만 +1 된다
        succeeded: counter === 'succeeded' ? sql`${guidelineJobs.succeeded} + 1` : undefined,
        skipped: counter === 'skipped' ? sql`${guidelineJobs.skipped} + 1` : undefined,
        failed: counter === 'failed' ? sql`${guidelineJobs.failed} + 1` : undefined,
        processed: sql`${guidelineJobs.succeeded} + ${guidelineJobs.skipped} + ${guidelineJobs.failed} + 1`,
      })
      .where(eq(guidelineJobs.id, jobId));
  }

  /**
   * 취소 표시 — RUNNING일 때만 CANCELLING이 된다. 이미 CANCELLING이면 0행이라 멱등 판정에 쓰고,
   * 종결 상태면 역시 0행이라 호출측이 409 `GUIDELINE_JOB_NOT_RUNNING`으로 나눈다
   * (현재 status는 호출측이 이미 읽고 있다). 조건을 SQL에 두어야 러너의 종결과 경합하지 않는다.
   */
  async markCancelling(jobId: string): Promise<number> {
    const rows = await this.txManager.conn
      .update(guidelineJobs)
      .set({ status: 'CANCELLING' })
      .where(and(eq(guidelineJobs.id, jobId), eq(guidelineJobs.status, 'RUNNING')))
      .returning({ id: guidelineJobs.id });
    return rows.length;
  }

  /**
   * 종결 상태 기록. **행을 잠근 뒤** 잠긴 값을 보고 최종 status를 정한다 —
   * 러너가 마지막 문서를 끝내는 순간 cancel이 들어오면 「COMPLETED로 쓸까 CANCELLED로 쓸까」가
   * 갈리는데, 잠금 밖에서 읽으면 그 사이에 상태가 바뀐다. 판정 자체(CANCELLING→CANCELLED 등)는
   * 도메인 정책이라 호출측 콜백이 갖고, 저장소는 「읽고-정하고-쓰기」가 원자적임만 보장한다.
   *
   * 잡이 없으면 null.
   */
  async finalize(
    jobId: string,
    decide: (current: GuidelineJobRow) => GuidelineJobFinalizeInput,
  ): Promise<GuidelineJobRow | null> {
    return this.txManager.run(async () => {
      const locked = await this.txManager.conn
        .select()
        .from(guidelineJobs)
        .where(eq(guidelineJobs.id, jobId))
        .limit(1)
        .for('update');
      const current = locked[0];
      if (!current) return null;

      const decision = decide(current);
      const rows = await this.txManager.conn
        .update(guidelineJobs)
        .set({
          status: decision.status,
          error: decision.error ?? null,
          finishedAt: new Date(),
        })
        .where(eq(guidelineJobs.id, jobId))
        .returning();
      return rows[0] ?? null;
    });
  }

  /**
   * 부팅 시 정리 (docs/specs/22 기준 11) — 단일 인스턴스라 부팅 시점에 살아 있는 잡은 정의상 없다.
   * 정리하지 않으면 partial unique index 때문에 **다음 잡을 영원히 시작할 수 없다.**
   */
  async sweepInterrupted(): Promise<number> {
    const rows = await this.txManager.conn
      .update(guidelineJobs)
      .set({ status: 'INTERRUPTED', finishedAt: new Date() })
      .where(inArray(guidelineJobs.status, ACTIVE_GUIDELINE_JOB_STATUSES))
      .returning({ id: guidelineJobs.id });
    return rows.length;
  }
}
