import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  ApiEnvelopeResponse,
  ApiPageResponse,
} from '../../../global/common/response/api-envelope.decorator';
import { PageResult } from '../../../global/common/response/page-result';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { CurrentClinician } from '../../../global/security/current-clinician.decorator';
import { CreateGuidelineJobRequestDto } from '../dto/request/create-guideline-job.request.dto';
import { ListGuidelineJobsQueryDto } from '../dto/request/list-guideline-jobs.query.dto';
import { ListPipelineRunsQueryDto } from '../dto/request/list-pipeline-runs.query.dto';
import { GuidelineJobDetailResponseDto } from '../dto/response/guideline-job-detail.response.dto';
import { GuidelineJobResponseDto } from '../dto/response/guideline-job.response.dto';
import { PipelineRunResponseDto } from '../dto/response/pipeline-run.response.dto';
import { GuidelineJobService } from '../service/guideline-job.service';

/**
 * 전건 파이프라인 잡 (docs/specs/22) — 전부 ADMIN 역할이 필요하다.
 *
 * **스텁 단계에서는 `@UseGuards(AdminGuard)`를 일부러 붙이지 않는다.**
 * 붙이면 수용 기준 1의 403 가지가 아무것도 구현하지 않은 상태에서 통과해 공허 테스트가 된다
 * (automation/freeze.md 5-③). 가드는 구현 커밋에서 부착한다.
 */
@ApiTags('Admin Guideline Job')
@Controller('admin/guideline-jobs')
export class AdminGuidelineJobController {
  constructor(private readonly jobService: GuidelineJobService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: '전건 수집→파싱→임베딩→적재 잡 시작 (202, 즉시 반환)' })
  @ApiEnvelopeResponse(GuidelineJobResponseDto, { status: 202 })
  create(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Body() request: CreateGuidelineJobRequestDto,
  ): Promise<GuidelineJobResponseDto> {
    return this.jobService.createJob(principal, request);
  }

  @Get()
  @ApiOperation({ summary: '잡 이력 — 최신순 커서' })
  @ApiPageResponse(GuidelineJobResponseDto)
  list(
    @Query() query: ListGuidelineJobsQueryDto,
  ): Promise<PageResult<GuidelineJobResponseDto>> {
    return this.jobService.listJobs(query);
  }

  @Get(':jobId')
  @ApiOperation({ summary: '잡 1건 + 문서별 실행 전체 중첩' })
  @ApiEnvelopeResponse(GuidelineJobDetailResponseDto)
  detail(@Param('jobId') jobId: string): Promise<GuidelineJobDetailResponseDto> {
    return this.jobService.getJob(jobId);
  }

  @Get(':jobId/stream')
  @ApiOperation({
    summary: '잡 진행 SSE (§8 — 봉투 미적용)',
    description:
      'job.snapshot → run.stage(단계마다) → job.completed. 모든 이벤트가 job 카운터를 함께 싣는다. ' +
      'GET이라 EventSource를 그대로 쓴다.',
  })
  @ApiProduces('text/event-stream')
  stream(@Param('jobId') jobId: string, @Res() res: Response): Promise<void> {
    return this.jobService.streamJob(jobId, res);
  }

  @Post(':jobId/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: '취소 요청 — CANCELLING 표시 후 현재 문서를 마치고 중단' })
  @ApiEnvelopeResponse(GuidelineJobResponseDto)
  cancel(@Param('jobId') jobId: string): Promise<GuidelineJobResponseDto> {
    return this.jobService.cancelJob(jobId);
  }
}

/**
 * 단계별 실행 이력 (docs/specs/22).
 * 잡에 속하지 않은 실행(§21 1건 동기 호출, §05 스크립트)까지 한 자리에서 본다.
 */
@ApiTags('Admin Guideline Job')
@Controller('admin/pipeline-runs')
export class AdminPipelineRunController {
  constructor(private readonly jobService: GuidelineJobService) {}

  @Get()
  @ApiOperation({ summary: '단계별 실행 이력 — 최신순 커서, jobId=null 실행 포함' })
  @ApiPageResponse(PipelineRunResponseDto)
  list(
    @Query() query: ListPipelineRunsQueryDto,
  ): Promise<PageResult<PipelineRunResponseDto>> {
    return this.jobService.listPipelineRuns(query);
  }
}
