/* eslint-disable @typescript-eslint/no-unused-vars -- 스텁: 시그니처만 두고 구현은 Phase 3 */
import { Injectable } from '@nestjs/common';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { PageResult } from '../../../global/common/response/page-result';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { ListClinicInvitationsQueryDto } from '../dto/request/list-clinic-invitations.query.dto';
import { ClinicInvitationIssuedResponseDto } from '../dto/response/clinic-invitation-issued.response.dto';
import { ClinicInvitationPreviewResponseDto } from '../dto/response/clinic-invitation-preview.response.dto';
import { ClinicInvitationResponseDto } from '../dto/response/clinic-invitation.response.dto';

/** 합류 시 auth가 요구하는 초대 해석 결과 */
export interface ResolvedInvitation {
  invitationId: string;
  clinicId: string;
}

@Injectable()
export class ClinicInvitationService {
  /** 발급 — 개설자 전용. 토큰 원문은 이 응답에서만 노출된다 */
  async issue(principal: ClinicianPrincipal): Promise<ClinicInvitationIssuedResponseDto> {
    throw new ServiceException('INTERNAL_ERROR');
  }

  /** 목록 — 개설자 전용. 토큰은 실리지 않는다 */
  async list(
    principal: ClinicianPrincipal,
    query: ListClinicInvitationsQueryDto,
  ): Promise<PageResult<ClinicInvitationResponseDto>> {
    throw new ServiceException('INTERNAL_ERROR');
  }

  /** 취소 — 개설자 전용 */
  async revoke(principal: ClinicianPrincipal, invitationId: string): Promise<null> {
    throw new ServiceException('INTERNAL_ERROR');
  }

  /** 비인증 프리뷰 — 한의원명만 준다 */
  async preview(token: string): Promise<ClinicInvitationPreviewResponseDto> {
    throw new ServiceException('INTERNAL_ERROR');
  }

  /**
   * 합류 경로가 쓰는 토큰 해석 — 유효하지 않거나 만료·사용·취소됐으면 `INVITATION_INVALID`.
   * 소비(consume)는 가입 트랜잭션 안에서 별도로 이뤄진다.
   */
  async resolveForJoin(token: string, now: Date): Promise<ResolvedInvitation> {
    throw new ServiceException('INTERNAL_ERROR');
  }

  /** 가입 트랜잭션 안에서 초대를 1회용으로 소비한다 */
  async consume(invitationId: string, clinicianId: string, now: Date): Promise<void> {
    throw new ServiceException('INTERNAL_ERROR');
  }
}
