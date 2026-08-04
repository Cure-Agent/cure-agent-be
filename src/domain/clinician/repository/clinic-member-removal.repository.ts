import { Injectable } from '@nestjs/common';
import { TransactionManager } from '../../../global/database/transaction-manager';
import {
  ClinicMemberRemovalRow,
  clinicMemberRemovals,
} from '../persistence/clinic-member-removal.schema';

/**
 * 강퇴 이력 (docs/specs/38).
 *
 * 조회 API는 없다(스펙 Out of scope) — 이력은 감사·분쟁 대응이 목적이라 서버에 남기는 것이
 * 먼저이고, §35 초대 목록과 달리 다음 행동(재발급·취소)이 딸리지 않는다.
 */
@Injectable()
export class ClinicMemberRemovalRepository {
  constructor(private readonly txManager: TransactionManager) {}

  async insert(
    row: Pick<
      ClinicMemberRemovalRow,
      'id' | 'clinicId' | 'removedClinicianId' | 'removedByClinicianId'
    >,
  ): Promise<void> {
    await this.txManager.conn.insert(clinicMemberRemovals).values(row);
  }
}
