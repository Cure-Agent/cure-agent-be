import { timestamp } from 'drizzle-orm/pg-core';

/**
 * 전 테이블 공통 auditing 컬럼 (architecture.md §3, §9).
 * 모든 persistence schema는 `...baseColumns`로 포함한다.
 */
export const baseColumns = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};
