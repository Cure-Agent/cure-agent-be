import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, ilike, inArray, lt } from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import {
  EvidenceChunkRow,
  GuidelineRow,
  GuidelineSectionRow,
  GuidelineVersionRow,
  evidenceChunks,
  guidelineSections,
  guidelineVersions,
  guidelines,
  ingestionRuns,
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

  async insertVersion(
    row: Pick<
      GuidelineVersionRow,
      'id' | 'guidelineId' | 'version' | 'publishedAt' | 'sourceUrl' | 'contentHash'
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

  async insertIngestionRun(row: typeof ingestionRuns.$inferInsert): Promise<void> {
    await this.txManager.conn.insert(ingestionRuns).values(row);
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
}
