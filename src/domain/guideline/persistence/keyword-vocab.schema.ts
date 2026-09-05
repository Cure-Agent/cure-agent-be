import { integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';
import { evidenceChunks } from './guideline.schema';

/**
 * 키워드 arm 어휘 프리필터 (docs/specs/45).
 *
 * 두 표 모두 **전건 로드로만 읽힌다** — 질의 시점 조회가 없으므로 조회용 인덱스를 두지 않는다.
 * PK/UNIQUE는 증분 갱신의 upsert·삭제가 쓴다.
 */

/**
 * 청크 → 포스팅이 가리키는 안정 정수 번호.
 *
 * ULID가 아니라 정수인 이유는 실측이다 — 표 14MB(ULID 38MB) · 로드 165ms(502ms) ·
 * 피크 힙 +64MB(+115MB). 대가인 ix 할당은 **identity 시퀀스로 append-only를 닫는다**:
 * `max(ix)+1`로 뽑으면 최대 ix를 가진 청크가 삭제될 때 그 번호가 재발급돼 포스팅이 남의
 * 청크를 가리킨다(기준 22). 시퀀스는 롤백·삭제에도 되감기지 않는다.
 */
export const keywordChunkIndex = pgTable(
  'keyword_chunk_index',
  {
    chunkId: text('chunk_id')
      .primaryKey()
      .references(() => evidenceChunks.id, { onDelete: 'cascade' }),
    ix: integer('ix').generatedAlwaysAsIdentity().notNull(),
    ...baseColumns,
  },
  (table) => [uniqueIndex('uq_keyword_chunk_index_ix').on(table.ix)],
);

/**
 * raw 어절 항 → 그 어절을 담은 청크 ix의 **집합**.
 *
 * DF를 컬럼으로 두지 않고 `cardinality(chunk_ixs)`로 파생한다 — 저장하면 두 값이 어긋날 수
 * 있고, #402의 정수 카운터 부풀림이 정확히 그 사고였다. 포스팅이 집합이라 증분 뺄셈이
 * 멱등이고 전량 재생성과 직접 대조된다.
 */
export const keywordVocab = pgTable('keyword_vocab', {
  term: text('term').primaryKey(),
  chunkIxs: integer('chunk_ixs').array().notNull(),
  ...baseColumns,
});

export type KeywordChunkIndexRow = typeof keywordChunkIndex.$inferSelect;
export type KeywordVocabRow = typeof keywordVocab.$inferSelect;
