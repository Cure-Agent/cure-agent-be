import { index, pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';
import { clinics } from './clinic.schema';
import { clinicians } from './clinician.schema';

/**
 * 구성원 강퇴 이력 (docs/specs/38).
 *
 * 강퇴는 `clinicians.clinic_id`를 NULL로 끊으므로, 이 테이블이 없으면 **그 사람이 어느 클리닉에
 * 있었는지가 어디에도 남지 않는다** — 강퇴당한 사람도 개설자도 근거를 볼 수 없다. §35가 초대를
 * TTL 소멸형(Redis)이 아니라 테이블로 둔 것과 같은 이유이며, 강퇴는 **타인 계정 처분**이라
 * 분쟁 소지가 초대보다 크다.
 *
 * **unique를 걸지 않는다** — 같은 사람이 다시 초대받아 합류했다가 또 강퇴되는 것이 정상 경로다.
 */
export const clinicMemberRemovals = pgTable(
  'clinic_member_removals',
  {
    id: text('id').primaryKey(), // ULID
    /** 강퇴가 일어난 클리닉. 대상의 `clinic_id`가 NULL이 된 뒤에도 여기에는 남는다 */
    clinicId: text('clinic_id')
      .notNull()
      .references(() => clinics.id),
    removedClinicianId: text('removed_clinician_id')
      .notNull()
      .references(() => clinicians.id),
    removedByClinicianId: text('removed_by_clinician_id')
      .notNull()
      .references(() => clinicians.id),
    // createdAt이 곧 강퇴 시각이다 — 별도 컬럼을 두지 않는다
    ...baseColumns,
  },
  (table) => [index('idx_clinic_member_removals_clinic').on(table.clinicId, table.createdAt)],
);

export type ClinicMemberRemovalRow = typeof clinicMemberRemovals.$inferSelect;
