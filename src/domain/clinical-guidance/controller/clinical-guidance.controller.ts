import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiEnvelopeResponse } from '../../../global/common/response/api-envelope.decorator';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { CurrentClinician } from '../../../global/security/current-clinician.decorator';
import { ReviewClinicalGuidanceRequestDto } from '../dto/request/review-clinical-guidance.request.dto';
import { ClinicalGuidanceResponseDto } from '../dto/response/clinical-guidance.response.dto';
import { ClinicalGuidanceService } from '../service/clinical-guidance.service';

@ApiTags('ClinicalGuidance')
@Controller('clinical-guidance')
export class ClinicalGuidanceController {
  constructor(private readonly clinicalGuidanceService: ClinicalGuidanceService) {}

  @Get(':guidanceId')
  @ApiOperation({ summary: '가이던스 상세 (검토 상태 포함)' })
  @ApiEnvelopeResponse(ClinicalGuidanceResponseDto)
  detail(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('guidanceId') guidanceId: string,
  ): Promise<ClinicalGuidanceResponseDto> {
    return this.clinicalGuidanceService.detail(principal, guidanceId);
  }

  @Post(':guidanceId/reviews')
  @HttpCode(200)
  @ApiOperation({ summary: '의료인 검토 확정 — DRAFT 상태에서 1회만 허용 (§5.6)' })
  @ApiEnvelopeResponse(ClinicalGuidanceResponseDto)
  review(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('guidanceId') guidanceId: string,
    @Body() dto: ReviewClinicalGuidanceRequestDto,
  ): Promise<ClinicalGuidanceResponseDto> {
    return this.clinicalGuidanceService.review(principal, guidanceId, dto);
  }
}
