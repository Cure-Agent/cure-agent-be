import { Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, lt } from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { PatientRow, patientProfileSnapshots, patients } from '../persistence/patient.schema';
import { PatientScope } from '../service/patient-snapshot.service';

export interface ListPatientsFilter {
  query?: string;
  status?: PatientRow['status'];
  afterId?: string;
  limit: number;
}

/** §4.4 — 모든 메서드는 PatientScope(clinicId) 필수. 스코프 없는 public 조회를 만들지 않는다. */
@Injectable()
export class PatientRepository {
  constructor(private readonly txManager: TransactionManager) {}

  async insert(row: typeof patients.$inferInsert): Promise<void> {
    await this.txManager.conn.insert(patients).values(row);
  }

  async findById(scope: PatientScope, id: string): Promise<PatientRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(patients)
      .where(and(eq(patients.id, id), eq(patients.clinicId, scope.clinicId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async list(scope: PatientScope, filter: ListPatientsFilter): Promise<PatientRow[]> {
    const conditions = [
      eq(patients.clinicId, scope.clinicId),
      filter.query ? ilike(patients.caseLabel, `%${filter.query}%`) : undefined,
      filter.status ? eq(patients.status, filter.status) : undefined,
      filter.afterId ? lt(patients.id, filter.afterId) : undefined,
    ].filter((c) => c !== undefined);

    return this.txManager.conn
      .select()
      .from(patients)
      .where(and(...conditions))
      .orderBy(desc(patients.id))
      .limit(filter.limit);
  }

  /**
   * 낙관적 잠금 갱신 — WHERE version까지 걸어 동시 수정 경합을 DB에서 차단한다.
   * 갱신된 행을 반환하고, 경합으로 0건이면 null.
   */
  async updateWithVersion(
    scope: PatientScope,
    id: string,
    expectedVersion: number,
    patch: Partial<typeof patients.$inferInsert>,
  ): Promise<PatientRow | null> {
    const rows = await this.txManager.conn
      .update(patients)
      .set({ ...patch, version: expectedVersion + 1 })
      .where(
        and(
          eq(patients.id, id),
          eq(patients.clinicId, scope.clinicId),
          eq(patients.version, expectedVersion),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** archive/unarchive — version은 건드리지 않는다 (동결 테스트 기준 7 계약) */
  async updateStatus(
    scope: PatientScope,
    id: string,
    status: PatientRow['status'],
  ): Promise<void> {
    await this.txManager.conn
      .update(patients)
      .set({ status })
      .where(and(eq(patients.id, id), eq(patients.clinicId, scope.clinicId)));
  }

  async insertSnapshot(row: typeof patientProfileSnapshots.$inferInsert): Promise<void> {
    await this.txManager.conn.insert(patientProfileSnapshots).values(row);
  }
}
