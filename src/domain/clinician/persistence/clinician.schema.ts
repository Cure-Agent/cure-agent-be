import { pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';
import { clinics } from './clinic.schema';

export const verificationStatus = pgEnum('verification_status', ['PENDING', 'VERIFIED', 'REJECTED']);
export const oauthProvider = pgEnum('oauth_provider', ['GOOGLE', 'KAKAO', 'NAVER']);

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
    ...baseColumns,
  },
  (table) => [
    uniqueIndex('uq_clinicians_email').on(table.email),
    uniqueIndex('uq_clinicians_oauth').on(table.oauthProvider, table.oauthProviderId),
  ],
);

export type ClinicianRow = typeof clinicians.$inferSelect;
