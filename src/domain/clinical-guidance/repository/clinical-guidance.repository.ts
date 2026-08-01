import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import {
  ClinicalGuidanceRow,
  clinicalGuidances,
  guidanceReviews,
} from '../persistence/clinical-guidance.schema';

/** §4.4 — 가이던스는 환자 계열 리소스: clinicId 스코프 */
export interface GuidanceScope {
  clinicId: string;
}

@Injectable()
export class ClinicalGuidanceRepository {
  constructor(private readonly txManager: TransactionManager) {}

  async insert(row: typeof clinicalGuidances.$inferInsert): Promise<ClinicalGuidanceRow> {
    const rows = await this.txManager.conn.insert(clinicalGuidances).values(row).returning();
    return rows[0];
  }

  async findById(scope: GuidanceScope, id: string): Promise<ClinicalGuidanceRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(clinicalGuidances)
      .where(and(eq(clinicalGuidances.id, id), eq(clinicalGuidances.clinicId, scope.clinicId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 메시지 목록에 guidanceId를 실어주기 위한 일괄 조회 — messageId → guidanceId */
  async findIdsByMessageIds(scope: GuidanceScope, messageIds: string[]): Promise<Map<string, string>> {
    if (messageIds.length === 0) return new Map();
    const rows = await this.txManager.conn
      .select({ id: clinicalGuidances.id, messageId: clinicalGuidances.messageId })
      .from(clinicalGuidances)
      .where(
        and(
          inArray(clinicalGuidances.messageId, messageIds),
          eq(clinicalGuidances.clinicId, scope.clinicId),
        ),
      );
    return new Map(rows.map((row) => [row.messageId, row.id]));
  }

  /** DRAFT일 때만 상태 전이 — 경합 시 0행 갱신으로 재검토를 원자적으로 차단한다 */
  async updateStatusIfDraft(
    scope: GuidanceScope,
    id: string,
    status: ClinicalGuidanceRow['reviewStatus'],
  ): Promise<ClinicalGuidanceRow | null> {
    const rows = await this.txManager.conn
      .update(clinicalGuidances)
      .set({ reviewStatus: status })
      .where(
        and(
          eq(clinicalGuidances.id, id),
          eq(clinicalGuidances.clinicId, scope.clinicId),
          eq(clinicalGuidances.reviewStatus, 'DRAFT'),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async insertReview(row: typeof guidanceReviews.$inferInsert): Promise<void> {
    await this.txManager.conn.insert(guidanceReviews).values(row);
  }
}
