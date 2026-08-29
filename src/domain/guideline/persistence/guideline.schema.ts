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
/**
 * 버전 단위 폐기 (docs/specs/21). guideline_status와 값은 같지만 대상이 다르다 —
 * 지침 단위로는 "이 판본만 내린다"를 표현할 수 없어 별도 enum을 둔다.
 */
export const guidelineVersionStatus = pgEnum('guideline_version_status', ['ACTIVE', 'SUPERSEDED']);

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
    version: text('version').notNull(), // 원문 판본 ("2024-07")
    /**
     * 같은 판본을 다시 파싱한 **우리 처리 회차** (docs/specs/21).
     * 지침이 개정되면 version이 바뀌고, 파서가 좋아지면 revision이 오른다 — 둘을 섞지 않는다.
     */
    revision: integer('revision').notNull().default(1),
    status: guidelineVersionStatus('status').notNull().default('ACTIVE'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    sourceUrl: text('source_url').notNull(),
    contentHash: text('content_hash').notNull(), // 입력 전문 해시 (재현성·변경 감지)
    ...baseColumns,
  },
  (table) => [
    uniqueIndex('uq_guideline_versions_revision').on(
      table.guidelineId,
      table.version,
      table.revision,
    ),
  ],
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
    // 벡터 좌표계 출처 — 검색은 같은 모델로 만들어진 청크만 대상으로 한다 (docs/specs/14)
    embeddingModel: text('embedding_model').notNull().default('fake-embedding-v1'),
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

/**
 * 청크 번역 (docs/specs/42) — embedding과 같은 규율의 파생물이다.
 *
 * **임베딩 컬럼을 두지 않는다**(기준 24). 검색 질의를 한국어로 통일했으므로 영문 벡터가 쓰일
 * 자리가 없고, 만들면 §14의 「같은 모델로 만들어진 청크만 검색 대상」에 언어 축이 하나 더 붙어
 * `policyVersion`이 언어까지 표현해야 하며 229문항 기준선이 무효화된다.
 *
 * `sourceContentHash`가 낡음의 유일한 판정 축이다 — `evidence_chunks.content_hash`와 다르면
 * 원문이 개정된 것이므로 그 번역은 싣지 않는다(기준 15·21). §18이 「벡터는 evidence_chunks에만」
 * 이라 한 것과 같은 이유로, 파생물은 자신이 무엇에서 파생됐는지를 들고 있어야 한다.
 *
 * `evidence_chunks`의 컬럼이 아니라 별도 테이블인 이유는 스펙 판단표에 있다 — 언어 추가에 스키마
 * 변경이 없고, 검색이 매 요청 읽는 hot row를 무겁게 하지 않는다.
 */
export const evidenceChunkTranslations = pgTable(
  'evidence_chunk_translations',
  {
    id: text('id').primaryKey(),
    chunkId: text('chunk_id')
      .notNull()
      .references(() => evidenceChunks.id),
    /** 'ko' | 'en' — 제3언어는 spec 42 Out of scope지만 컬럼이 확장을 막지는 않는다 */
    lang: text('lang').notNull(),
    content: text('content').notNull(),
    /** 번역 시점 원문 해시 — evidence_chunks.content_hash와 대조해 stale을 가른다 */
    sourceContentHash: text('source_content_hash').notNull(),
    /** provenance (기준 22) — 어느 모델이 만든 번역인지 행마다 기록한다 */
    translatorModel: text('translator_model').notNull(),
    translatedAt: timestamp('translated_at', { withTimezone: true }).notNull().defaultNow(),
    ...baseColumns,
  },
  (table) => [
    // 잡 멱등성 (기준 18) — 같은 청크·같은 언어는 한 행뿐이다
    uniqueIndex('uq_evidence_chunk_translations_chunk_lang').on(table.chunkId, table.lang),
  ],
);

export type GuidelineRow = typeof guidelines.$inferSelect;
export type GuidelineVersionRow = typeof guidelineVersions.$inferSelect;
export type GuidelineSectionRow = typeof guidelineSections.$inferSelect;
export type EvidenceChunkRow = typeof evidenceChunks.$inferSelect;
export type EvidenceChunkTranslationRow = typeof evidenceChunkTranslations.$inferSelect;
