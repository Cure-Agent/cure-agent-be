import { pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';
import { clinics } from './clinic.schema';

export const verificationStatus = pgEnum('verification_status', ['PENDING', 'VERIFIED', 'REJECTED']);

export const clinicians = pgTable(
  'clinicians',
  {
    id: text('id').primaryKey(), // ULID
    clinicId: text('clinic_id')
      .notNull()
      .references(() => clinics.id),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    // 면허번호는 AES-GCM 암호문으로만 저장한다 (architecture.md §4.5)
    licenseNumberEncrypted: text('license_number_encrypted').notNull(),
    verificationStatus: verificationStatus('verification_status').notNull().default('PENDING'),
    ...baseColumns,
  },
  (table) => [uniqueIndex('uq_clinicians_email').on(table.email)],
);

export type ClinicianRow = typeof clinicians.$inferSelect;
