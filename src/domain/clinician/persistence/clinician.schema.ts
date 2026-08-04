import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';
import { clinics } from './clinic.schema';

export const verificationStatus = pgEnum('verification_status', ['PENDING', 'VERIFIED', 'REJECTED']);
export const oauthProvider = pgEnum('oauth_provider', ['GOOGLE', 'KAKAO', 'NAVER']);
/**
 * 관리 엔드포인트 접근 권한 (docs/specs/21).
 * 토큰 페이로드에 넣지 않는다 — 박으면 권한 회수가 access TTL만큼 지연된다.
 * 최초 ADMIN 지정은 수동 UPDATE다 (역할 관리 API는 Out of scope).
 */
export const clinicianRole = pgEnum('clinician_role', ['ADMIN', 'MEMBER']);

export const clinicians = pgTable(
  'clinicians',
  {
    id: text('id').primaryKey(), // ULID
    clinicId: text('clinic_id')
      .notNull()
      .references(() => clinics.id),
    email: text('email').notNull(),
    // 계정 동일성의 단일 기준 (docs/specs/17). 비밀번호는 저장하지 않는다.
    oauthProvider: oauthProvider('oauth_provider').notNull(),
    oauthProviderId: text('oauth_provider_id').notNull(),
    displayName: text('display_name').notNull(),
    // 면허번호는 AES-GCM 암호문으로만 저장한다 (architecture.md §4.5)
    licenseNumberEncrypted: text('license_number_encrypted').notNull(),
    verificationStatus: verificationStatus('verification_status').notNull().default('PENDING'),
    role: clinicianRole('role').notNull().default('MEMBER'),
    /**
     * 탈퇴 시각 (docs/specs/36) — 이 값이 찍힌 행은 **tombstone**이다.
     *
     * 행을 지우지 않는 이유는 `clinicians`를 참조하는 FK가 8개이고 그중 5개가 notNull이기 때문이다.
     * 특히 `answer_feedbacks`·`guidance_reviews`는 「누가 평가·검토했는가」가 기록의 본질이라
     * 작성자가 사라지면 감사 기록이 무의미해진다. 대화도 §35 이후 클리닉 공유 자산이라
     * 지우면 남은 동료가 보던 기록이 사라진다.
     *
     * 개인정보(email·oauthProviderId·displayName·licenseNumberEncrypted)는 이 시각과 **같은
     * 트랜잭션에서 즉시 익명화**된다 — 파기는 미룰 이유가 없다.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...baseColumns,
  },
  (table) => [
    uniqueIndex('uq_clinicians_email').on(table.email),
    uniqueIndex('uq_clinicians_oauth').on(table.oauthProvider, table.oauthProviderId),
    // 구성원 목록·파기 스캔은 탈퇴한 소수만 훑는다 (docs/specs/36)
    index('idx_clinicians_deleted')
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
  ],
);

export type ClinicianRow = typeof clinicians.$inferSelect;
