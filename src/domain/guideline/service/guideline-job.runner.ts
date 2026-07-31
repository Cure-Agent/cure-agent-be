import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { CLS_ID, ClsService } from 'nestjs-cls';
import { ulid } from 'ulid';
import { GuidelineJobResponseDto } from '../dto/response/guideline-job.response.dto';
import { toGuidelineJob, toPipelineRun } from '../mapper/guideline-job.mapper';
import { RealTimeAlertSender } from '../../../global/observability/real-time-alert.sender';
import {
  GuidelineJobRow,
  GuidelineJobStatus,
  PipelineRunRow,
  PipelineRunStatus,
} from '../persistence/guideline-job.schema';
import { GuidelineJobCounter, GuidelineJobRepository } from '../repository/guideline-job.repository';
import { PipelineRunRepository } from '../repository/pipeline-run.repository';
import { GuidelineJobEventBus } from '../sse/guideline-job-event.bus';
import { GuidelineAcquisitionService } from './guideline-acquisition.service';
import { GuidelinePipelineService } from './guideline-pipeline.service';

/** 실행이 종결된 상태 → 잡 카운터의 어느 항목에 잡히는가 */
const COUNTER_OF: Partial<Record<PipelineRunStatus, GuidelineJobCounter>> = {
  SUCCEEDED: 'succeeded',
  SKIPPED: 'skipped',
  FAILED: 'failed',
};

/** 러너가 종료를 기다려주는 상한 — 배포 시 현재 문서를 마칠 시간을 준다 */
const SHUTDOWN_GRACE_MS = 20_000;

/** 크론 잡 결과 알림의 제목에 쓰는 종결 표현 (docs/specs/26) */
const JOB_RESULT_LABEL: Partial<Record<GuidelineJobStatus, string>> = {
  COMPLETED: '완료',
  FAILED: '실패',
  CANCELLED: '취소',
  INTERRUPTED: '중단',
};

/**
 * 전건 파이프라인 인프로세스 러너 (docs/specs/22).
 *
 * 큐를 들이지 않는다 — 배포가 단일 서버·단일 컨테이너이고 NCKM에 **순차** 요청하므로 워커 풀이
 * 쓰일 자리가 없다. 동시에 도는 잡도 1개이고 그건 DB의 partial unique index가 강제한다.
 *
 * **잡은 스트림과 무관하게 끝까지 돈다.** 구독자가 0명이어도, 보던 관리자가 창을 닫아도 계속한다.
 */
@Injectable()
export class GuidelineJobRunner implements BeforeApplicationShutdown {
  private readonly logger = new Logger(GuidelineJobRunner.name);
  /** 진행 중인 잡의 완료 프라미스 — 종료 시 드레인에 쓴다 */
  private current: Promise<void> | null = null;

  constructor(
    private readonly jobs: GuidelineJobRepository,
    private readonly runs: PipelineRunRepository,
    private readonly acquisition: GuidelineAcquisitionService,
    private readonly pipeline: GuidelinePipelineService,
    private readonly bus: GuidelineJobEventBus,
    private readonly cls: ClsService,
    // 크론이 만든 잡의 결과 통보 (docs/specs/26) — 지켜보는 사람이 없는 잡이다
    private readonly alerts: RealTimeAlertSender,
  ) {}

  /**
   * 백그라운드 시작. POST가 202를 즉시 돌려주기 위해 **await하지 않는다.**
   * 같은 tick에 `.catch()`를 붙여 unhandled rejection을 막는다.
   */
  start(job: GuidelineJobRow, externalIds?: string[]): void {
    // 요청 CLS를 상속하면 끝난 요청의 traceId·트랜잭션 잔재를 물려받는다 — 새 컨텍스트를 판다
    const task = this.cls
      .run(() => {
        // ContextModule은 요청 단위로만 id를 발급하므로 백그라운드 실행은 직접 심는다
        this.cls.set(CLS_ID, ulid());
        return this.execute(job, externalIds);
      })
      .catch((error: unknown) => {
        this.logger.error(`잡 ${job.id} 러너 실패: ${String(error)}`);
      })
      .finally(() => {
        this.current = null;
      });
    this.current = task;
  }

  /** 배포로 컨테이너가 내려갈 때 현재 문서를 마칠 시간을 준다 */
  async beforeApplicationShutdown(): Promise<void> {
    if (!this.current) return;
    await Promise.race([
      this.current,
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
    ]);
  }

  private async execute(jobRow: GuidelineJobRow, externalIds?: string[]): Promise<void> {
    // 첫 실행 행을 INSERT하기 **전에** 등록한다 — 늦으면 「행은 보이는데 버스에 없다」는 창이 생긴다
    let job: GuidelineJobResponseDto = toGuidelineJob(jobRow);
    this.bus.register(job);

    try {
      const listed = await this.acquisition.listDocuments(externalIds);
      // 요청한 id는 원본에 없어도 대상이다 — 그래야 NOT_FOUND 실행 행이 남고 total과 맞아떨어진다
      const targets = externalIds ?? listed.map((item) => item.externalId);

      await this.jobs.setTotal(jobRow.id, targets.length);
      job = await this.refresh(jobRow.id, job);

      let cancelled = false;
      for (const [order, externalId] of targets.entries()) {
        // 매 문서를 시작하기 **직전에** 취소를 확인한다 — 첫 문서도 예외가 아니다.
        // 여기서 빠져나가면 그 문서의 실행 행이 아예 생기지 않는다.
        const latest = await this.jobs.findById(jobRow.id);
        if (!latest || latest.status === 'CANCELLING') {
          cancelled = true;
          break;
        }

        // 개별 문서의 실패가 잡을 멈추지 않는다 — outcome.error는 여기서 의도적으로 버린다.
        // 무엇이 왜 실패했는지는 실행 행의 errorCode·phase에 이미 남았다 (§18 배치와 같은 규칙).
        await this.pipeline.runOne({
          externalId,
          jobId: jobRow.id,
          order,
          onStage: async (run) => {
            job = await this.onStage(jobRow.id, job, run);
          },
        });
      }

      await this.finalize(jobRow.id, cancelled ? 'CANCELLED' : 'COMPLETED');
    } catch (error) {
      // 러너 자체가 죽어 남은 문서를 시도하지 못한 경우다 — 개별 문서 실패와 구분된다
      this.logger.error(`잡 ${jobRow.id} 중단: ${String(error)}`);
      await this.finalize(jobRow.id, 'FAILED', String(error).slice(0, 2000));
    }
  }

  /**
   * 단계 진입·종결을 SSE로 중계한다. 실행이 종결됐으면 **카운터를 먼저 올리고** 최신 잡을 실어
   * 보낸다 — 그래야 종결 이벤트의 진행률이 그 문서를 포함한다.
   */
  private async onStage(
    jobId: string,
    job: GuidelineJobResponseDto,
    run: PipelineRunRow,
  ): Promise<GuidelineJobResponseDto> {
    const counter = COUNTER_OF[run.status];
    let next = job;
    if (counter) {
      await this.jobs.incrementCounter(jobId, counter);
      next = await this.refresh(jobId, job);
    }
    this.bus.emitRunStage(next, toPipelineRun(run));
    return next;
  }

  private async refresh(
    jobId: string,
    fallback: GuidelineJobResponseDto,
  ): Promise<GuidelineJobResponseDto> {
    const row = await this.jobs.findById(jobId);
    const next = row ? toGuidelineJob(row) : fallback;
    this.bus.syncJob(next);
    return next;
  }

  /**
   * 종결. `FOR UPDATE`로 잠근 뒤 정하므로 cancel 요청과 마지막 문서 종료가 경합하지 않는다 —
   * 잠금 밖에서 status를 읽으면 cancel 응답(CANCELLING)과 최종 상태가 어긋난다.
   */
  private async finalize(
    jobId: string,
    intended: 'COMPLETED' | 'CANCELLED' | 'FAILED',
    error?: string,
  ): Promise<void> {
    const row = await this.jobs.finalize(jobId, (locked) => ({
      // 러너가 정상 완주했더라도 그 사이 취소가 들어왔으면 CANCELLED로 끝난다
      status: intended === 'COMPLETED' && locked.status === 'CANCELLING' ? 'CANCELLED' : intended,
      error: error ?? null,
    }));
    const job = row ? toGuidelineJob(row) : null;
    if (job) this.bus.complete(job);
    if (row) await this.notifyScheduledResult(row);
  }

  /**
   * 크론이 만든 잡의 결과를 알린다 (docs/specs/26).
   *
   * **트리거는 잡의 「종결」이지 특정 status가 아니다** — 완료·실패·취소·중단 모두 나간다.
   * `MANUAL` 잡은 사람이 SSE로 지켜보고 있으므로 조용하다(§22의 논거).
   *
   * 알림 실패가 잡 결과를 바꾸지 않는다 (§15의 fire-and-forget).
   */
  private async notifyScheduledResult(row: GuidelineJobRow): Promise<void> {
    if (row.triggeredBy !== 'SCHEDULE') return;

    try {
      const runs = await this.runs.listByJobId(row.id);
      // 알림만 보고 어느 문서를 봐야 하는지 알 수 있어야 한다 (기준 26)
      const failures = runs
        .filter((run) => run.status === 'FAILED')
        .map((run) => `- ${run.externalId ?? '(식별자 없음)'}: ${run.errorCode ?? 'UNKNOWN'}`);

      const detail = [
        `jobId=${row.id}`,
        `total=${row.total} succeeded=${row.succeeded} skipped=${row.skipped} failed=${row.failed}`,
        ...(row.error ? [`사유: ${row.error}`] : []),
        ...(failures.length > 0 ? ['실패한 문서:', ...failures] : []),
      ].join('\n');

      this.alerts.send({
        title: `지침 개정 감지 잡 ${JOB_RESULT_LABEL[row.status] ?? row.status}`,
        detail,
      });
    } catch (error) {
      this.logger.warn(`잡 ${row.id} 결과 알림 실패: ${String(error)}`);
    }
  }
}
