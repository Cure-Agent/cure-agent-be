/* eslint-disable @typescript-eslint/no-unused-vars -- 스텁: 시그니처만 두고 구현은 Phase 3 */
import { Injectable } from '@nestjs/common';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { ClinicInvitationRow } from '../persistence/clinic-invitation.schema';

/** 초대 목록 항목 + 합류자 표시 이름 (조인 결과) */
export interface ClinicInvitationListRow {
  invitation: ClinicInvitationRow;
  acceptedByDisplayName: string | null;
}

@Injectable()
export class ClinicInvitationRepository {
  constructor(private readonly txManager: TransactionManager) {}

  async insert(
    row: Pick<
      ClinicInvitationRow,
      'id' | 'clinicId' | 'invitedByClinicianId' | 'tokenHash' | 'expiresAt'
    >,
  ): Promise<ClinicInvitationRow> {
    throw new Error('not implemented');
  }

  async list(
    clinicId: string,
    filter: { after?: { createdAt: string; id: string }; limit: number },
  ): Promise<ClinicInvitationListRow[]> {
    throw new Error('not implemented');
  }

  async findById(id: string): Promise<ClinicInvitationRow | null> {
    throw new Error('not implemented');
  }

  /** 취소 — 자기 클리닉 것만. 0행이면 미존재/타 클리닉이다 */
  async revoke(clinicId: string, id: string, revokedAt: Date): Promise<boolean> {
    throw new Error('not implemented');
  }

  /**
   * 1회용 소비 — `accepted_at IS NULL` 조건부 UPDATE라 동시 요청이 겹쳐도 한 번만 성립한다
   * (§34 softDelete의 「덮지 않는다」 집행과 같은 형태). 0행이면 이미 소비됐다.
   */
  async consume(
    id: string,
    acceptedAt: Date,
    acceptedByClinicianId: string,
  ): Promise<boolean> {
    throw new Error('not implemented');
  }
}
