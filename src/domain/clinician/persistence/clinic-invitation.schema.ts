import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';
import { clinics } from './clinic.schema';
import { clinicians } from './clinician.schema';

/**
 * 클리닉 합류 초대 (docs/specs/35).
 *
 * 상태 컬럼을 두지 않는다 — `PENDING`·`ACCEPTED`·`REVOKED`·`EXPIRED`는 아래 세 시각에서
 * **파생**한다. 만료를 컬럼으로 두면 값을 넘겨줄 주체(크론·조회 시 갱신)가 따로 필요해진다.
 */
export const clinicInvitations = pgTable(
  'clinic_invitations',
  {
    /** ULID — 토큰 `{id}.{secret}`의 앞부분이자 조회 키다 (§4.3 refresh 쿠키와 같은 형태) */
    id: text('id').primaryKey(),
    clinicId: text('clinic_id')
      .notNull()
      .references(() => clinics.id),
    invitedByClinicianId: text('invited_by_clinician_id')
      .notNull()
      .references(() => clinicians.id),
    /**
     * 토큰 원문은 저장하지 않는다 — sha256만 남긴다 (§4.3 refresh 토큰 관행).
     * 원문을 저장하면 DB 유출이 곧 합류 권한 유출이다. 부작용으로 **발급 응답이 토큰을 보여줄
     * 유일한 기회**가 되며, 분실 시 재발급뿐이고 목록 API는 토큰을 실을 수 없다.
     */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByClinicianId: text('accepted_by_clinician_id').references(() => clinicians.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...baseColumns,
  },
  (table) => [index('idx_clinic_invitations_clinic').on(table.clinicId, table.createdAt)],
);

export type ClinicInvitationRow = typeof clinicInvitations.$inferSelect;
