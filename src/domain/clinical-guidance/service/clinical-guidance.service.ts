import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { ReviewClinicalGuidanceRequestDto } from '../dto/request/review-clinical-guidance.request.dto';
import { ClinicalGuidanceResponseDto } from '../dto/response/clinical-guidance.response.dto';
import { toClinicalGuidanceDto } from '../mapper/clinical-guidance.mapper';
import { ClinicalGuidanceRepository } from '../repository/clinical-guidance.repository';

@Injectable()
export class ClinicalGuidanceService {
  constructor(
    private readonly repository: ClinicalGuidanceRepository,
    private readonly txManager: TransactionManager,
  ) {}

  async detail(
    principal: ClinicianPrincipal,
    guidanceId: string,
  ): Promise<ClinicalGuidanceResponseDto> {
    const row = await this.repository.findById({ clinicId: principal.clinicId }, guidanceId);
    if (!row) throw new ServiceException('NOT_FOUND');
    return toClinicalGuidanceDto(row);
  }

  async review(
    principal: ClinicianPrincipal,
    guidanceId: string,
    dto: ReviewClinicalGuidanceRequestDto,
  ): Promise<ClinicalGuidanceResponseDto> {
    const scope = { clinicId: principal.clinicId };
    return this.txManager.run(async () => {
      // DRAFT 조건부 UPDATE가 경합의 최종 방어선 — 0행이면 미존재/기검토를 구분해 응답한다
      const updated = await this.repository.updateStatusIfDraft(scope, guidanceId, dto.decision);
      if (!updated) {
        const existing = await this.repository.findById(scope, guidanceId);
        if (!existing) throw new ServiceException('NOT_FOUND');
        throw new ServiceException('GUIDANCE_ALREADY_REVIEWED');
      }

      await this.repository.insertReview({
        id: ulid(),
        guidanceId,
        clinicianId: principal.clinicianId,
        decision: dto.decision,
        note: dto.note ?? null,
      });
      return toClinicalGuidanceDto(updated);
    });
  }
}
