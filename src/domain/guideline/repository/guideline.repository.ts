import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  ilike,
  inArray,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { messageCitations } from '../../conversation/persistence/conversation.schema';
import {
  EvidenceChunkRow,
  evidenceChunkTranslations,
  GuidelineRow,
  GuidelineSectionRow,
  GuidelineVersionRow,
  evidenceChunks,
  guidelineSections,
  guidelineVersions,
  guidelines,
} from '../persistence/guideline.schema';

export interface ListGuidelinesFilter {
  query?: string;
  status?: GuidelineRow['status'];
  publisher?: string;
  afterId?: string; // 커서 (id desc 순서)
  limit: number;
}

export interface ListEvidenceFilter {
  guidelineVersionId: string;
  afterId?: string; // 커서 (id asc 순서)
  limit: number;
}

export interface ListAdminGuidelinesFilter {
  query?: string;
  publisher?: string;
  afterId?: string; // 커서 (id desc 순서)
  limit: number;
}

@Injectable()
export class GuidelineRepository {
  constructor(private readonly txManager: TransactionManager) {}

  // ── 인제스트 쓰기 ─────────────────────────────────────

  async findByTitlePublisher(title: string, publisher: string): Promise<GuidelineRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(guidelines)
      .where(and(eq(guidelines.title, title), eq(guidelines.publisher, publisher)))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertGuideline(row: Pick<GuidelineRow, 'id' | 'title' | 'publisher'>): Promise<void> {
    await this.txManager.conn.insert(guidelines).values(row);
  }

  async findVersion(guidelineId: string, version: string): Promise<GuidelineVersionRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(guidelineVersions)
      .where(
        and(eq(guidelineVersions.guidelineId, guidelineId), eq(guidelineVersions.version, version)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 재적재 멱등성 기준 (docs/specs/21) — 판본이 아니라 **내용 해시**가 같아야 skip이다.
   * 파서가 좋아지면 같은 판본이라도 내용이 달라지고, 그때는 새 revision이 되어야 한다.
   */
  async findVersionByContentHash(
    guidelineId: string,
    version: string,
    contentHash: string,
  ): Promise<GuidelineVersionRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(guidelineVersions)
      .where(
        and(
          eq(guidelineVersions.guidelineId, guidelineId),
          eq(guidelineVersions.version, version),
          eq(guidelineVersions.contentHash, contentHash),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** 같은 판본의 최대 revision — 다음 회차 번호를 정한다 */
  async findMaxRevision(guidelineId: string, version: string): Promise<number> {
    const rows = await this.txManager.conn
      .select({ revision: guidelineVersions.revision })
      .from(guidelineVersions)
      .where(
        and(eq(guidelineVersions.guidelineId, guidelineId), eq(guidelineVersions.version, version)),
      )
      .orderBy(desc(guidelineVersions.revision))
      .limit(1);
    return rows[0]?.revision ?? 0;
  }

  /**
   * 같은 판본의 다른 revision을 전부 SUPERSEDED로 내린다 (docs/specs/21).
   * 대상은 `(guidelineId, version)`에 한정된다 — 새 판본 적재가 옛 판본을 내리지 않는다.
   */
  async supersedeOtherRevisions(
    guidelineId: string,
    version: string,
    keepVersionId: string,
  ): Promise<void> {
    await this.txManager.conn
      .update(guidelineVersions)
      .set({ status: 'SUPERSEDED' })
      .where(
        and(
          eq(guidelineVersions.guidelineId, guidelineId),
          eq(guidelineVersions.version, version),
          ne(guidelineVersions.id, keepVersionId),
        ),
      );
  }

  async insertVersion(
    row: Pick<
      GuidelineVersionRow,
      | 'id'
      | 'guidelineId'
      | 'version'
      | 'revision'
      | 'status'
      | 'publishedAt'
      | 'sourceUrl'
      | 'contentHash'
    >,
  ): Promise<void> {
    await this.txManager.conn.insert(guidelineVersions).values(row);
  }

  async insertSection(
    row: Pick<GuidelineSectionRow, 'id' | 'guidelineVersionId' | 'title' | 'path' | 'order'>,
  ): Promise<void> {
    await this.txManager.conn.insert(guidelineSections).values(row);
  }

  async insertChunks(
    rows: Pick<
      EvidenceChunkRow,
      | 'id'
      | 'sectionId'
      | 'guidelineVersionId'
      | 'content'
      | 'embedding'
      | 'recommendationNumber'
      | 'recommendationGrade'
      | 'evidenceLevel'
      | 'pageStart'
      | 'pageEnd'
      | 'order'
      | 'contentHash'
    >[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.txManager.conn.insert(evidenceChunks).values(rows);
  }

  // ── 조회 ─────────────────────────────────────────────

  async listGuidelines(filter: ListGuidelinesFilter): Promise<GuidelineRow[]> {
    const conditions = [
      filter.query ? ilike(guidelines.title, `%${filter.query}%`) : undefined,
      filter.status ? eq(guidelines.status, filter.status) : undefined,
      filter.publisher ? eq(guidelines.publisher, filter.publisher) : undefined,
      filter.afterId ? lt(guidelines.id, filter.afterId) : undefined,
    ].filter((c) => c !== undefined);

    return this.txManager.conn
      .select()
      .from(guidelines)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(guidelines.id))
      .limit(filter.limit);
  }

  async findGuidelineById(id: string): Promise<GuidelineRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(guidelines)
      .where(eq(guidelines.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** guideline별 최신 버전 (publishedAt desc → id desc). */
  async findLatestVersions(guidelineIds: string[]): Promise<Map<string, GuidelineVersionRow>> {
    if (guidelineIds.length === 0) return new Map();
    const rows = await this.txManager.conn
      .select()
      .from(guidelineVersions)
      .where(inArray(guidelineVersions.guidelineId, guidelineIds))
      .orderBy(desc(guidelineVersions.publishedAt), desc(guidelineVersions.id));

    const latest = new Map<string, GuidelineVersionRow>();
    for (const row of rows) {
      if (!latest.has(row.guidelineId)) latest.set(row.guidelineId, row);
    }
    return latest;
  }

  async listEvidence(
    filter: ListEvidenceFilter,
  ): Promise<{ chunk: EvidenceChunkRow; section: GuidelineSectionRow }[]> {
    const conditions = [
      eq(evidenceChunks.guidelineVersionId, filter.guidelineVersionId),
      filter.afterId ? gt(evidenceChunks.id, filter.afterId) : undefined,
    ].filter((c) => c !== undefined);

    return this.txManager.conn
      .select({ chunk: evidenceChunks, section: guidelineSections })
      .from(evidenceChunks)
      .innerJoin(guidelineSections, eq(evidenceChunks.sectionId, guidelineSections.id))
      .where(and(...conditions))
      .orderBy(asc(evidenceChunks.id))
      .limit(filter.limit);
  }

  // ── 코퍼스 관리 (docs/specs/21) ────────────────────────

  /** 관리 목록 — status 필터가 없다. 폐기된 것을 찾는 게 이 화면의 목적이다. */
  async listGuidelinesForAdmin(filter: ListAdminGuidelinesFilter): Promise<GuidelineRow[]> {
    const conditions = [
      filter.query ? ilike(guidelines.title, `%${filter.query}%`) : undefined,
      filter.publisher ? eq(guidelines.publisher, filter.publisher) : undefined,
      filter.afterId ? lt(guidelines.id, filter.afterId) : undefined,
    ].filter((c) => c !== undefined);

    return this.txManager.conn
      .select()
      .from(guidelines)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(guidelines.id))
      .limit(filter.limit);
  }

  /**
   * 지침들의 버전 이력 + 청크 수. 판본 내림차순 → revision 내림차순으로 정렬한다.
   * 청크가 0개인 버전도 나와야 하므로 LEFT JOIN이다.
   */
  async listVersionsWithChunkCount(
    guidelineIds: string[],
  ): Promise<(GuidelineVersionRow & { chunkCount: number })[]> {
    if (guidelineIds.length === 0) return [];
    return this.txManager.conn
      .select({
        ...getTableColumns(guidelineVersions),
        chunkCount: sql<number>`count(${evidenceChunks.id})::int`,
      })
      .from(guidelineVersions)
      .leftJoin(evidenceChunks, eq(evidenceChunks.guidelineVersionId, guidelineVersions.id))
      .where(inArray(guidelineVersions.guidelineId, guidelineIds))
      .groupBy(guidelineVersions.id)
      .orderBy(desc(guidelineVersions.version), desc(guidelineVersions.revision));
  }

  async findVersionById(versionId: string): Promise<GuidelineVersionRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(guidelineVersions)
      .where(eq(guidelineVersions.id, versionId))
      .limit(1);
    return rows[0] ?? null;
  }

  async countChunks(versionId: string): Promise<number> {
    const rows = await this.txManager.conn
      .select({ count: sql<number>`count(*)::int` })
      .from(evidenceChunks)
      .where(eq(evidenceChunks.guidelineVersionId, versionId));
    return rows[0]?.count ?? 0;
  }

  async updateVersionStatus(
    versionId: string,
    status: GuidelineVersionRow['status'],
  ): Promise<void> {
    await this.txManager.conn
      .update(guidelineVersions)
      .set({ status })
      .where(eq(guidelineVersions.id, versionId));
  }

  /** 이 버전의 청크를 인용한 메시지 수 — 하나라도 있으면 삭제를 거부한다 */
  async countCitations(versionId: string): Promise<number> {
    const rows = await this.txManager.conn
      .select({ count: sql<number>`count(*)::int` })
      .from(messageCitations)
      .innerJoin(evidenceChunks, eq(messageCitations.evidenceChunkId, evidenceChunks.id))
      .where(eq(evidenceChunks.guidelineVersionId, versionId));
    return rows[0]?.count ?? 0;
  }

  /** 청크 → 섹션 → 버전 순. FK 방향이라 이 순서를 지켜야 한다. */
  async deleteVersionCascade(versionId: string): Promise<void> {
    await this.txManager.conn
      .delete(evidenceChunks)
      .where(eq(evidenceChunks.guidelineVersionId, versionId));
    await this.txManager.conn
      .delete(guidelineSections)
      .where(eq(guidelineSections.guidelineVersionId, versionId));
    await this.txManager.conn.delete(guidelineVersions).where(eq(guidelineVersions.id, versionId));
  }

  async countVersions(guidelineId: string): Promise<number> {
    const rows = await this.txManager.conn
      .select({ count: sql<number>`count(*)::int` })
      .from(guidelineVersions)
      .where(eq(guidelineVersions.guidelineId, guidelineId));
    return rows[0]?.count ?? 0;
  }

  async deleteGuideline(guidelineId: string): Promise<void> {
    await this.txManager.conn.delete(guidelines).where(eq(guidelines.id, guidelineId));
  }

  async findEvidenceDetail(evidenceId: string): Promise<{
    chunk: EvidenceChunkRow;
    section: GuidelineSectionRow;
    version: GuidelineVersionRow;
    guideline: GuidelineRow;
  } | null> {
    const rows = await this.txManager.conn
      .select({
        chunk: evidenceChunks,
        section: guidelineSections,
        version: guidelineVersions,
        guideline: guidelines,
      })
      .from(evidenceChunks)
      .innerJoin(guidelineSections, eq(evidenceChunks.sectionId, guidelineSections.id))
      .innerJoin(guidelineVersions, eq(evidenceChunks.guidelineVersionId, guidelineVersions.id))
      .innerJoin(guidelines, eq(guidelineVersions.guidelineId, guidelines.id))
      .where(eq(evidenceChunks.id, evidenceId))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── 청크 번역 (docs/specs/42) ──────────────────────────

  /**
   * 번역이 필요한 ACTIVE 청크 — 없거나 stale한 것만 (기준 18·21).
   *
   * **제목 비교는 `btrim(title, E' \t\n\r')`이다.** ACTIVE 63건 중 2건의 제목에 후행 탭이
   * 있고 그중 하나가 데모 6주제의 ADHD인데, PostgreSQL `trim()`은 공백만 지우고 탭을 남긴다 —
   * `trim()`으로 비교하면 그 지침이 대상에서 조용히 빠진다(기준 20).
   */
  async listChunksNeedingTranslation(
    lang: string,
    titlePrefixes: readonly string[] | null,
  ): Promise<{ chunk: EvidenceChunkRow; guidelineTitle: string; stale: boolean }[]> {
    const normalizedTitle = sql`btrim(${guidelines.title}, E' \t\n\r')`;
    const scoped = titlePrefixes
      ? or(...titlePrefixes.map((prefix) => sql`${normalizedTitle} LIKE ${`${prefix}%`}`))
      : undefined;

    const rows = await this.txManager.conn
      .select({
        chunk: evidenceChunks,
        guidelineTitle: guidelines.title,
        translationHash: evidenceChunkTranslations.sourceContentHash,
      })
      .from(evidenceChunks)
      .innerJoin(guidelineVersions, eq(evidenceChunks.guidelineVersionId, guidelineVersions.id))
      .innerJoin(guidelines, eq(guidelineVersions.guidelineId, guidelines.id))
      .leftJoin(
        evidenceChunkTranslations,
        and(
          eq(evidenceChunkTranslations.chunkId, evidenceChunks.id),
          eq(evidenceChunkTranslations.lang, lang),
        ),
      )
      .where(and(eq(guidelineVersions.status, 'ACTIVE'), scoped));

    return rows.map((row) => ({
      chunk: row.chunk,
      guidelineTitle: row.guidelineTitle,
      // 번역이 없거나(null) 원문이 개정돼 해시가 갈린 것 — 둘 다 「다시 써야 한다」다
      stale: row.translationHash !== row.chunk.contentHash,
    }));
  }

  /** 같은 (chunk, lang)은 한 행뿐이다 — 재실행이 행을 늘리지 않는다 (기준 18) */
  async upsertChunkTranslation(row: typeof evidenceChunkTranslations.$inferInsert): Promise<void> {
    await this.txManager.conn
      .insert(evidenceChunkTranslations)
      .values(row)
      .onConflictDoUpdate({
        target: [evidenceChunkTranslations.chunkId, evidenceChunkTranslations.lang],
        set: {
          content: row.content,
          titleTranslated: row.titleTranslated ?? null,
          sourceContentHash: row.sourceContentHash,
          translatorModel: row.translatorModel,
          translatedAt: new Date(),
        },
      });
  }
}
