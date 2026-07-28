import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { baseColumns } from '../../../global/database/base-columns';

/**
 * 지침 원본 수집 추적 (docs/specs/18).
 * 원본 PDF는 저장하지 않는다 — 해시만 남겨 개정 감지의 기준으로 쓴다.
 * 이 테이블은 임베딩을 갖지 않는다: 벡터는 evidence_chunks에만 존재한다.
 */
export const sourceDocumentStatus = pgEnum('source_document_status', [
  'FETCHED',
  'SKIPPED_NO_ATTACHMENT',
  'FAILED',
]);

export const sourceDocuments = pgTable(
  'source_documents',
  {
    id: text('id').primaryKey(), // ULID
    sourceSystem: text('source_system').notNull(), // 'NCKM'
    externalId: text('external_id').notNull(), // guide_idx
    title: text('title').notNull(),
    publisher: text('publisher').notNull(),
    /** 목록이 "2024-07"처럼 일자 없이 주므로 날짜 타입으로 파싱하지 않고 원문을 보존한다 */
    releaseDate: text('release_date'),
    sourceUrl: text('source_url').notNull(),
    /**
     * 응답 본문을 받았으면 그 내용이 무엇이든 sha256 (PDF든 HTML 에러 페이지든).
     * 본문 자체를 못 받은 네트워크 실패만 NULL이며, 그 행은 아래 unique 대상에서 빠진다.
     */
    fileHash: text('file_hash'),
    fileBytes: integer('file_bytes'),
    contentType: text('content_type'),
    status: sourceDocumentStatus('status').notNull(),
    error: text('error'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    ...baseColumns,
  },
  (table) => [
    // partial unique: NULL(본문 없는 실패)은 제약 밖 — 실패 이력은 누적되는 것이 의도된 동작이다.
    // 일반 unique로 두면 Postgres가 NULL을 서로 다른 값으로 취급해 재실행마다 중복이 쌓인다.
    uniqueIndex('uq_source_documents_external_hash')
      .on(table.sourceSystem, table.externalId, table.fileHash)
      .where(sql`${table.fileHash} IS NOT NULL`),
    index('idx_source_documents_external').on(table.sourceSystem, table.externalId),
  ],
);

export type SourceDocumentRow = typeof sourceDocuments.$inferSelect;
export type SourceDocumentStatus = (typeof sourceDocumentStatus.enumValues)[number];
