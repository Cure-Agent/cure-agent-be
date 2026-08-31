import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiEnvelopeResponse } from '../../../global/common/response/api-envelope.decorator';
import { EvidenceDetailQueryDto } from '../dto/request/evidence-detail.query.dto';
import { EvidenceDetailResponseDto } from '../dto/response/evidence-detail.response.dto';
import { GuidelineService } from '../service/guideline.service';

@ApiTags('Evidence')
@Controller('evidence')
export class EvidenceController {
  constructor(private readonly guidelineService: GuidelineService) {}

  @Get(':evidenceId')
  @ApiOperation({ summary: '인용 근거 원문 상세' })
  @ApiEnvelopeResponse(EvidenceDetailResponseDto)
  detail(
    @Param('evidenceId') evidenceId: string,
    @Query() query: EvidenceDetailQueryDto,
  ): Promise<EvidenceDetailResponseDto> {
    return this.guidelineService.evidenceDetail(evidenceId, query.lang ?? 'ko');
  }
}
