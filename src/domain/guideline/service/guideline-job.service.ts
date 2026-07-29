import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ulid } from 'ulid';
import { decodeCursor, encodeCursor } from '../../../global/common/cursor/cursor.util';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { PageResult } from '../../../global/common/response/page-result';
import { SseStream } from '../../../global/common/sse/sse-stream';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { CreateGuidelineJobRequestDto } from '../dto/request/create-guideline-job.request.dto';
import { ListGuidelineJobsQueryDto } from '../dto/request/list-guideline-jobs.query.dto';
import { ListPipelineRunsQueryDto } from '../dto/request/list-pipeline-runs.query.dto';
import { GuidelineJobDetailResponseDto } from '../dto/response/guideline-job-detail.response.dto';
import { GuidelineJobResponseDto } from '../dto/response/guideline-job.response.dto';
import { PipelineRunResponseDto } from '../dto/response/pipeline-run.response.dto';
import { toGuidelineJob, toPipelineRun } from '../mapper/guideline-job.mapper';
import { GuidelineJobRow } from '../persistence/guideline-job.schema';
import {
  ACTIVE_GUIDELINE_JOB_STATUSES,
  GuidelineJobRepository,
  isActiveGuidelineJobConflict,
} from '../repository/guideline-job.repository';
import { PipelineRunRepository } from '../repository/pipeline-run.repository';
import { GuidelineJobEventBus } from '../sse/guideline-job-event.bus';
import { GuidelineJobStreamEventDto } from '../sse/guideline-job-stream-event.dto';
import { GuidelineJobRunner } from './guideline-job.runner';

const DEFAULT_SIZE = 20;

interface JobCursor extends Record<string, unknown> {
  id: string;
}

/**
 * 전건 파이프라인 잡 유스케이스 (docs/specs/22).
 */
@Injectable()
export class GuidelineJobService {
  constructor(
    private readonly jobs: GuidelineJobRepository,
    private readonly runs: PipelineRunRepository,
    private readonly runner: GuidelineJobRunner,
    private readonly bus: GuidelineJobEventBus,
  ) {}

  /**
   * 잡 행을 `RUNNING`·카운터 0으로 만들어 **그대로** 돌려준다 — 원본 목록은 러너가 받는다.
   * 응답 직전에 재조회하지 않으므로 잡이 아무리 빨리 끝나도 POST 응답의 status는 항상 RUNNING이다.
   *
   * 동시 실행 1개는 앱 메모리 플래그가 아니라 **DB의 partial unique index**가 막는다 —
   * 재시작·중복 요청 어느 쪽에서도 같은 규칙이 성립한다.
   */
  async createJob(
    principal: ClinicianPrincipal,
    request: CreateGuidelineJobRequestDto,
  ): Promise<GuidelineJobResponseDto> {
    let row: GuidelineJobRow;
    try {
      row = await this.jobs.insert({ id: ulid(), requestedBy: principal.clinicianId });
    } catch (error) {
      if (isActiveGuidelineJobConflict(error)) {
        throw new ServiceException('GUIDELINE_JOB_ALREADY_RUNNING');
      }
      throw error;
    }

    this.runner.start(row, request.externalIds);
    return toGuidelineJob(row);
  }

  async listJobs(
    query: ListGuidelineJobsQueryDto,
  ): Promise<PageResult<GuidelineJobResponseDto>> {
    const size = query.size ?? DEFAULT_SIZE;
    const afterId = query.cursor ? decodeCursor<JobCursor>(query.cursor).id : undefined;

    // limit+1로 다음 페이지 존재 여부를 판단한다
    const rows = await this.jobs.listByCursor({ afterId, limit: size + 1 });
    const hasNext = rows.length > size;
    const page = rows.slice(0, size);

    return PageResult.of(page.map(toGuidelineJob), {
      size,
      hasNext,
      nextCursor: hasNext ? encodeCursor({ id: page[page.length - 1].id }) : null,
    });
  }

  /** 잡 + 문서별 실행을 order 오름차순으로 중첩해 담는다 */
  async getJob(jobId: string): Promise<GuidelineJobDetailResponseDto> {
    const row = await this.requireJob(jobId);
    const runs = await this.runs.listByJobId(jobId);
    return { ...toGuidelineJob(row), runs: runs.map(toPipelineRun) };
  }

  /**
   * `CANCELLING`으로 표시만 하는 **멱등** 연산. 러너가 현재 문서를 마친 뒤 루프를 빠져나온다 —
   * 다운로드·파싱 중간에 끊으면 부분 적재를 만들 수 있고, 1건은 10~20초라 기다릴 만하다.
   */
  async cancelJob(jobId: string): Promise<GuidelineJobResponseDto> {
    const row = await this.requireJob(jobId);
    // 종결 상태의 잡만 409다 — 이미 CANCELLING이면 200으로 현재 상태를 돌려준다
    if (!ACTIVE_GUIDELINE_JOB_STATUSES.includes(row.status)) {
      throw new ServiceException('GUIDELINE_JOB_NOT_RUNNING');
    }

    await this.jobs.markCancelling(jobId);
    const updated = await this.jobs.findById(jobId);
    return toGuidelineJob(updated ?? row);
  }

  /**
   * 진행 스트림. **헤더를 보내기 전에 잡 존재를 검증한다** — `flushHeaders` 이후에는 예외 필터가
   * `headersSent`로 포기해 404가 조용히 삼켜진다.
   *
   * 진행 중인 잡의 스냅샷은 **버스의 메모리 미러**에서 만든다. DB에서 읽으면 「읽기」와 「구독
   * 등록」 사이에 `await`가 생겨 그 구간의 이벤트를 놓치거나 중복으로 받는다. 끝난 잡은 더 이상
   * 변하지 않으므로 DB에서 읽어도 안전하다.
   */
  async streamJob(jobId: string, res: Response): Promise<void> {
    const row = await this.requireJob(jobId);

    // ── 여기부터 종결까지 await가 없다: attach와 스냅샷 발신이 한 동기 구간이다 ──
    const stream = new SseStream(res);
    const attached = this.bus.attach(jobId, (event) => {
      stream.send(event);
      if (event.eventType === 'job.completed') stream.end();
    });

    if (attached) {
      this.send(stream, {
        eventType: 'job.snapshot',
        job: attached.job,
        runs: attached.runs,
      });
      res.on('close', () => {
        attached.detach();
        stream.end();
      });
      return;
    }

    // 이미 끝난 잡 — 스냅샷 + 종결을 즉시 보내고 닫는다. 폴링 없이 결과를 확인하는 경로다
    const runs = await this.runs.listByJobId(jobId);
    const job = toGuidelineJob(row);
    this.send(stream, { eventType: 'job.snapshot', job, runs: runs.map(toPipelineRun) });
    this.send(stream, { eventType: 'job.completed', job });
    stream.end();
  }

  /** 잡 밖의 단건 실행(jobId=null)까지 포함한 단계별 이력. 항상 최신순 */
  async listPipelineRuns(
    query: ListPipelineRunsQueryDto,
  ): Promise<PageResult<PipelineRunResponseDto>> {
    const size = query.size ?? DEFAULT_SIZE;
    const afterId = query.cursor ? decodeCursor<JobCursor>(query.cursor).id : undefined;

    const rows = await this.runs.listByCursor({
      jobId: query.jobId,
      externalId: query.externalId,
      status: query.status,
      phase: query.phase,
      afterId,
      limit: size + 1,
    });
    const hasNext = rows.length > size;
    const page = rows.slice(0, size);

    return PageResult.of(page.map(toPipelineRun), {
      size,
      hasNext,
      nextCursor: hasNext ? encodeCursor({ id: page[page.length - 1].id }) : null,
    });
  }

  private async requireJob(jobId: string): Promise<GuidelineJobRow> {
    const row = await this.jobs.findById(jobId);
    if (!row) throw new ServiceException('NOT_FOUND');
    return row;
  }

  private send(stream: SseStream, event: GuidelineJobStreamEventDto): void {
    stream.send(event as unknown as Record<string, unknown>);
  }
}
