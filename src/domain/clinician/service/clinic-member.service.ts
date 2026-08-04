/* eslint-disable @typescript-eslint/no-unused-vars -- 스텁: 시그니처만 두고 구현은 Phase 3 */
import { Injectable } from '@nestjs/common';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { TransferClinicOwnerRequestDto } from '../dto/request/transfer-clinic-owner.request.dto';
import { ClinicMemberResponseDto } from '../dto/response/clinic-member.response.dto';

@Injectable()
export class ClinicMemberService {
  /** 구성원 목록 — 전원 조회 가능. 탈퇴한 tombstone은 제외한다 */
  async list(principal: ClinicianPrincipal): Promise<ClinicMemberResponseDto[]> {
    throw new ServiceException('INTERNAL_ERROR');
  }

  /** 개설자 이양 — 대상이 같은 클리닉의 살아 있는 구성원이 아니면 NOT_FOUND (§4.4) */
  async transferOwner(
    principal: ClinicianPrincipal,
    dto: TransferClinicOwnerRequestDto,
  ): Promise<null> {
    throw new ServiceException('INTERNAL_ERROR');
  }
}
