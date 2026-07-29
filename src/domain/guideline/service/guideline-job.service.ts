import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { PageResult } from '../../../global/common/response/page-result';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { CreateGuidelineJobRequestDto } from '../dto/request/create-guideline-job.request.dto';
import { ListGuidelineJobsQueryDto } from '../dto/request/list-guideline-jobs.query.dto';
import { ListPipelineRunsQueryDto } from '../dto/request/list-pipeline-runs.query.dto';
import { GuidelineJobDetailResponseDto } from '../dto/response/guideline-job-detail.response.dto';
import { GuidelineJobResponseDto } from '../dto/response/guideline-job.response.dto';
import { PipelineRunResponseDto } from '../dto/response/pipeline-run.response.dto';

const NOT_IMPLEMENTED = '아직 구현되지 않았습니다 (docs/specs/22)';

/**
 * 전건 파이프라인 잡 유스케이스 (docs/specs/22).
 *
 * **스텁이다** — automation/freeze.md 1번에 따라 컴파일에 필요한 시그니처만 두고 로직은 없다.
 * 인터페이스 시그니처는 아키텍처 결정이라 구현측이 소유한다.
 */
@Injectable()
export class GuidelineJobService {
  /** 잡 행을 RUNNING·카운터 0으로 만들어 그대로 돌려준다. 원본 목록은 러너가 받는다 */
  createJob(
    _principal: ClinicianPrincipal,
    _request: CreateGuidelineJobRequestDto,
  ): Promise<GuidelineJobResponseDto> {
    throw new Error(NOT_IMPLEMENTED);
  }

  listJobs(
    _query: ListGuidelineJobsQueryDto,
  ): Promise<PageResult<GuidelineJobResponseDto>> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** 잡 + 문서별 실행을 order 오름차순으로 중첩해 담는다 */
  getJob(_jobId: string): Promise<GuidelineJobDetailResponseDto> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** CANCELLING 표시만 하는 멱등 연산 — 종결 상태의 잡에만 409다 */
  cancelJob(_jobId: string): Promise<GuidelineJobResponseDto> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /**
   * 진행 스트림. **헤더를 보내기 전에 잡 존재를 검증해야** 404가 봉투로 나간다 —
   * flushHeaders 이후에는 예외 필터가 headersSent로 포기한다.
   */
  streamJob(_jobId: string, _res: Response): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** 잡 밖의 단건 실행(jobId=null)까지 포함한 단계별 이력. 항상 최신순 */
  listPipelineRuns(
    _query: ListPipelineRunsQueryDto,
  ): Promise<PageResult<PipelineRunResponseDto>> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
