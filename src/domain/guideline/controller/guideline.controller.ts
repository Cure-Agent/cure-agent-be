import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiEnvelopeResponse,
  ApiPageResponse,
} from '../../../global/common/response/api-envelope.decorator';
import { PageResult } from '../../../global/common/response/page-result';
import { ListEvidenceQueryDto } from '../dto/request/list-evidence.query.dto';
import { ListGuidelinesQueryDto } from '../dto/request/list-guidelines.query.dto';
import { EvidenceSummaryResponseDto } from '../dto/response/evidence-summary.response.dto';
import { GuidelineDetailResponseDto } from '../dto/response/guideline-detail.response.dto';
import { GuidelineSummaryResponseDto } from '../dto/response/guideline-summary.response.dto';
import { GuidelineService } from '../service/guideline.service';

@ApiTags('Guideline')
@Controller('guidelines')
export class GuidelineController {
  constructor(private readonly guidelineService: GuidelineService) {}

  @Get()
  @ApiOperation({ summary: '지침 검색·필터 목록 (커서 기반)' })
  @ApiPageResponse(GuidelineSummaryResponseDto)
  list(@Query() query: ListGuidelinesQueryDto): Promise<PageResult<GuidelineSummaryResponseDto>> {
    return this.guidelineService.list(query);
  }

  @Get(':guidelineId')
  @ApiOperation({ summary: '지침 상세 (현재 버전 포함)' })
  @ApiEnvelopeResponse(GuidelineDetailResponseDto)
  detail(@Param('guidelineId') guidelineId: string): Promise<GuidelineDetailResponseDto> {
    return this.guidelineService.detail(guidelineId);
  }

  @Get(':guidelineId/evidence')
  @ApiOperation({ summary: '지침의 섹션·권고문(근거 청크) 목록' })
  @ApiPageResponse(EvidenceSummaryResponseDto)
  listEvidence(
    @Param('guidelineId') guidelineId: string,
    @Query() query: ListEvidenceQueryDto,
  ): Promise<PageResult<EvidenceSummaryResponseDto>> {
    return this.guidelineService.listEvidence(guidelineId, query);
  }
}
