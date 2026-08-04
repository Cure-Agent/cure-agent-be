import { pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';

export const clinics = pgTable('clinics', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull(),
  /**
   * 개설자 (docs/specs/35) — 초대 발급·조회·취소 권한이 이 한 사람에게 묶인다.
   * `clinicians.role`(ADMIN/MEMBER)은 **플랫폼 관리 권한**이라 재활용하지 않는다(§21, admin.guard).
   *
   * **NULL 허용이 필수다.** `clinicians.clinic_id → clinics.id`와 순환 참조라 notNull이면 clinic을
   * 먼저 insert할 수 없다. 생성 순서는 clinic(owner NULL) → clinician → clinic UPDATE owner다.
   * FK 제약은 마이그레이션 SQL에만 둔다 — 여기서 `references(() => clinicians.id)`를 쓰면
   * 두 스키마 파일이 순환 import가 된다 (`conversations.clinic_id`와 같은 선례).
   */
  ownerClinicianId: text('owner_clinician_id'),
  ...baseColumns,
});

export type ClinicRow = typeof clinics.$inferSelect;
