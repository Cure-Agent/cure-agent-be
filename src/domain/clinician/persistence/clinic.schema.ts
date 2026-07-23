import { pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';

export const clinics = pgTable('clinics', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull(),
  ...baseColumns,
});

export type ClinicRow = typeof clinics.$inferSelect;
