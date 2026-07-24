import { Injectable } from '@nestjs/common';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { ReviewClinicalGuidanceRequestDto } from '../dto/request/review-clinical-guidance.request.dto';
import { ClinicalGuidanceResponseDto } from '../dto/response/clinical-guidance.response.dto';

@Injectable()
export class ClinicalGuidanceService {
  detail(_principal: ClinicianPrincipal, _guidanceId: string): Promise<ClinicalGuidanceResponseDto> {
    return Promise.reject(new Error('NOT_IMPLEMENTED'));
  }

  review(
    _principal: ClinicianPrincipal,
    _guidanceId: string,
    _dto: ReviewClinicalGuidanceRequestDto,
  ): Promise<ClinicalGuidanceResponseDto> {
    return Promise.reject(new Error('NOT_IMPLEMENTED'));
  }
}
