import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';
import { clinicians } from '../../clinician/persistence/clinician.schema';

/**
 * refresh 세션 (architecture.md §4.3).
 * - familyId: 로그인 1회가 만드는 rotation 체인의 식별자
 * - rotatedAt이 있는 세션의 재사용 = 탈취 신호 → family 전체 폐기
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(), // ULID
    clinicianId: text('clinician_id')
      .notNull()
      .references(() => clinicians.id),
    familyId: text('family_id').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    reuseDetectedAt: timestamp('reuse_detected_at', { withTimezone: true }),
    ...baseColumns,
  },
  (table) => [index('idx_auth_sessions_family').on(table.familyId)],
);

export type AuthSessionRow = typeof authSessions.$inferSelect;
