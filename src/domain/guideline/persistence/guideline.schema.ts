import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';

export const EMBEDDING_DIMENSIONS = 1536;

/** 권고등급·근거수준 — 문서마다 체계가 달라 enum이 아닌 구조체로 저장 (§7 RatingResponseDto) */
export interface RatingValue {
  system: string;
  code: string;
  label: string;
}

export const guidelineStatus = pgEnum('guideline_status', ['ACTIVE', 'SUPERSEDED']);
export const ingestionStatus = pgEnum('ingestion_status', ['SUCCEEDED', 'FAILED']);

export const guidelines = pgTable(
  'guidelines',
  {
    id: text('id').primaryKey(), // ULID
    title: text('title').notNull(),
    publisher: text('publisher').notNull(),
    status: guidelineStatus('status').notNull().default('ACTIVE'),
    ...baseColumns,
  },
  (table) => [uniqueIndex('uq_guidelines_title_publisher').on(table.title, table.publisher)],
);

export const guidelineVersions = pgTable(
  'guideline_versions',
  {
    id: text('id').primaryKey(),
    guidelineId: text('guideline_id')
      .notNull()
      .references(() => guidelines.id),
    version: text('version').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    sourceUrl: text('source_url').notNull(),
    contentHash: text('content_hash').notNull(), // 입력 전문 해시 (재현성·변경 감지)
    ...baseColumns,
  },
  (table) => [uniqueIndex('uq_guideline_versions_version').on(table.guidelineId, table.version)],
);

export const guidelineSections = pgTable(
  'guideline_sections',
  {
    id: text('id').primaryKey(),
    guidelineVersionId: text('guideline_version_id')
      .notNull()
      .references(() => guidelineVersions.id),
    title: text('title').notNull(),
    path: text('path').array().notNull(), // §7 sectionPath
    order: integer('order').notNull(),
    ...baseColumns,
  },
  (table) => [index('idx_guideline_sections_version').on(table.guidelineVersionId)],
);

export const evidenceChunks = pgTable(
  'evidence_chunks',
  {
    id: text('id').primaryKey(),
    sectionId: text('section_id')
      .notNull()
      .references(() => guidelineSections.id),
    guidelineVersionId: text('guideline_version_id')
      .notNull()
      .references(() => guidelineVersions.id),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    recommendationNumber: text('recommendation_number'),
    recommendationGrade: jsonb('recommendation_grade').$type<RatingValue>(),
    evidenceLevel: jsonb('evidence_level').$type<RatingValue>(),
    pageStart: integer('page_start'),
    pageEnd: integer('page_end'),
    order: integer('order').notNull(),
    contentHash: text('content_hash').notNull(),
    ...baseColumns,
  },
  (table) => [
    // 재인제스트 멱등성 (docs/specs/05)
    uniqueIndex('uq_evidence_chunks_version_hash').on(table.guidelineVersionId, table.contentHash),
    index('idx_evidence_chunks_section').on(table.sectionId),
  ],
);

export const ingestionRuns = pgTable('ingestion_runs', {
  id: text('id').primaryKey(),
  status: ingestionStatus('status').notNull(),
  inputHash: text('input_hash').notNull(),
  guidelineId: text('guideline_id'),
  guidelineVersionId: text('guideline_version_id'),
  stats: jsonb('stats').$type<{ sections: number; chunks: number; skippedChunks: number }>(),
  error: text('error'),
  ...baseColumns,
});

export type GuidelineRow = typeof guidelines.$inferSelect;
export type GuidelineVersionRow = typeof guidelineVersions.$inferSelect;
export type GuidelineSectionRow = typeof guidelineSections.$inferSelect;
export type EvidenceChunkRow = typeof evidenceChunks.$inferSelect;
