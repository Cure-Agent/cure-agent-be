import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';

export const clinics = pgTable(
  'clinics',
  {
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
     *
     * 같은 순환 때문에 **클리닉 파기 시 이 값을 NULL로 끊는 UPDATE가 선행**해야 한다
     * (docs/specs/36 파기 순서 ⑤) — 그러지 않으면 `clinicians` 삭제가 FK로 실패한다.
     */
    ownerClinicianId: text('owner_clinician_id'),
    /**
     * 파기 예약 시각 (docs/specs/36) — **마지막 구성원이 탈퇴하면** 찍힌다.
     *
     * 접근자가 0명이 된 환자·대화가 무기한 남는 것은 건강정보 보관으로 정당화되지 않는다(§4.5).
     * §34와 같이 「복구 유예」가 아니라 「파기 예약」이며, 유예가 지나면 파기 크론이 클리닉 전체를
     * 물리 삭제한다 — 한 클리닉 파기가 다단 역순 삭제라 요청 트랜잭션 밖으로 밀어낸 결과다.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...baseColumns,
  },
  (table) => [
    // 파기 스캔은 예약된 소수만 훑는다 — 살아 있는 클리닉은 인덱스에 들어오지 않는다 (§34 선례)
    index('idx_clinics_purge')
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
  ],
);

export type ClinicRow = typeof clinics.$inferSelect;
