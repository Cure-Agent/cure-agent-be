import { Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, isNull, lt } from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { conversations } from '../../conversation/persistence/conversation.schema';
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
      .where(
        and(
          eq(patients.id, id),
          eq(patients.clinicId, scope.clinicId),
          isNull(patients.deletedAt), // docs/specs/34 기준 12
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async list(scope: PatientScope, filter: ListPatientsFilter): Promise<PatientRow[]> {
    const conditions = [
      eq(patients.clinicId, scope.clinicId),
      isNull(patients.deletedAt), // docs/specs/34 기준 11
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

  /** 스코프 안에 존재하는가 — **파기 예약된 행도 존재로 센다** (대화 쪽과 같은 이유) */
  async existsInScope(scope: PatientScope, id: string): Promise<boolean> {
    const rows = await this.txManager.conn
      .select({ one: patients.id })
      .from(patients)
      .where(and(eq(patients.id, id), eq(patients.clinicId, scope.clinicId)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * 환자 삭제의 연쇄 — 그 환자의 대화에도 파기 예약을 찍는다 (docs/specs/34 기준 9).
   *
   * **`conversations` 테이블 쓰기를 여기에 두는 이유**: ConversationModule이 이미 PatientModule을
   * import하므로 역방향 주입은 DI 순환이다. 스키마 객체 import는 순환을 만들지 않고, 이 쓰기는
   * 「환자를 지운다」는 단일 유스케이스의 한 트랜잭션에 속한다.
   *
   * WHERE의 `deleted_at IS NULL`이 **먼저 삭제된 대화의 시각을 지켜준다** (기준 10).
   */
  async softDeleteConversationsByPatient(patientId: string, deletedAt: Date): Promise<void> {
    await this.txManager.conn
      .update(conversations)
      .set({ deletedAt })
      .where(and(eq(conversations.patientId, patientId), isNull(conversations.deletedAt)));
  }

  /**
   * 파기 예약 (docs/specs/34) — **이미 값이 있으면 덮지 않는다** (기준 6과 같은 이유).
   * 보관(status)과 직교하므로 ARCHIVED 환자도 그대로 예약된다 (기준 23).
   */
  async softDelete(scope: PatientScope, id: string, deletedAt: Date): Promise<void> {
    await this.txManager.conn
      .update(patients)
      .set({ deletedAt })
      .where(
        and(
          eq(patients.id, id),
          eq(patients.clinicId, scope.clinicId),
          isNull(patients.deletedAt), // 「덮지 않는다」 집행
        ),
      );
  }
}
