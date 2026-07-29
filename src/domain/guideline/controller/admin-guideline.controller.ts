import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiEnvelopeResponse,
  ApiPageResponse,
} from '../../../global/common/response/api-envelope.decorator';
import { PageResult } from '../../../global/common/response/page-result';
import { AdminGuard } from '../../../global/security/admin.guard';
import { ListAdminGuidelinesQueryDto } from '../dto/request/list-admin-guidelines.query.dto';
import { RunPipelineRequestDto } from '../dto/request/run-pipeline.request.dto';
import { UpdateVersionStatusRequestDto } from '../dto/request/update-version-status.request.dto';
import { AdminGuidelineVersionResponseDto } from '../dto/response/admin-guideline-version.response.dto';
import { AdminGuidelineResponseDto } from '../dto/response/admin-guideline.response.dto';
import { AdminIngestResponseDto } from '../dto/response/admin-ingest.response.dto';
import { GuidelineAdminService } from '../service/guideline-admin.service';

/**
 * 지침 코퍼스 관리 (docs/specs/21) — 전부 ADMIN 역할이 필요하다.
 * 관리 화면이 소비할 계약이므로 OpenAPI에 포함한다.
 */
@ApiTags('Admin Guideline')
@UseGuards(AdminGuard)
@Controller('admin/guidelines')
export class AdminGuidelineController {
  constructor(private readonly adminService: GuidelineAdminService) {}

  @Post('pipeline')
  @ApiOperation({ summary: '문서 1건 수집→파싱→적재 (동기)' })
  @ApiEnvelopeResponse(AdminIngestResponseDto, { status: 201 })
  runPipeline(@Body() request: RunPipelineRequestDto): Promise<AdminIngestResponseDto> {
    return this.adminService.runPipeline(request);
  }

  @Get()
  @ApiOperation({ summary: '지침 목록 — 버전 이력 중첩 (커서 기반)' })
  @ApiPageResponse(AdminGuidelineResponseDto)
  list(
    @Query() query: ListAdminGuidelinesQueryDto,
  ): Promise<PageResult<AdminGuidelineResponseDto>> {
    return this.adminService.listGuidelines(query);
  }
}

@ApiTags('Admin Guideline')
@UseGuards(AdminGuard)
@Controller('admin/guideline-versions')
export class AdminGuidelineVersionController {
  constructor(private readonly adminService: GuidelineAdminService) {}

  @Patch(':versionId')
  @ApiOperation({ summary: '버전 폐기·복구 (ACTIVE ↔ SUPERSEDED)' })
  @ApiEnvelopeResponse(AdminGuidelineVersionResponseDto)
  updateStatus(
    @Param('versionId') versionId: string,
    @Body() request: UpdateVersionStatusRequestDto,
  ): Promise<AdminGuidelineVersionResponseDto> {
    return this.adminService.updateVersionStatus(versionId, request);
  }

  @Delete(':versionId')
  @HttpCode(204)
  @ApiOperation({ summary: '버전·섹션·청크 삭제 — 인용이 있으면 409' })
  delete(@Param('versionId') versionId: string): Promise<void> {
    return this.adminService.deleteVersion(versionId);
  }
}
