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
  isNotNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { SupportedLang } from '../../../infrastructure/llm/translation/translator.port';
import { messageCitations } from '../../conversation/persistence/conversation.schema';
import {
  EvidenceChunkRow,
  EvidenceChunkTranslationRow,
  evidenceChunkTranslations,
  GuidelineRow,
  GuidelineSectionRow,
  GuidelineVersionRow,
  evidenceChunks,
  guidelineSections,
  guidelineVersions,
  guidelines,
} from '../persistence/guideline.schema';
import { keywordChunkIndex, keywordVocab } from '../persistence/keyword-vocab.schema';

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
   * 곧 SUPERSEDED로 내려갈 **현재 ACTIVE인** 다른 revision들 (docs/specs/45).
   *
   * 인제스트가 어휘에서 뺄 대상이다. 이미 SUPERSEDED인 revision은 어휘에 들어 있지 않으므로
   * 제외한다 — 넣으면 판본마다 어휘 전건 UPDATE가 한 번씩 헛돈다(실측 ~0.9s/회).
   */
  async listOtherActiveRevisionIds(
    guidelineId: string,
    version: string,
    keepVersionId: string,
  ): Promise<string[]> {
    const rows = await this.txManager.conn
      .select({ id: guidelineVersions.id })
      .from(guidelineVersions)
      .where(
        and(
          eq(guidelineVersions.guidelineId, guidelineId),
          eq(guidelineVersions.version, version),
          ne(guidelineVersions.id, keepVersionId),
          eq(guidelineVersions.status, 'ACTIVE'),
        ),
      );
    return rows.map((row) => row.id);
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

  /**
   * @param lang 근거 번역을 함께 실을 언어 (docs/specs/44). `listCitationDetails`의 조인과 같은
   *   모양이다 — 번역은 **left join**이라 없으면 null로 오고, 조인이 없으면 이 경로는 인자를
   *   받든 말든 구조적으로 영원히 한국어다(스펙 관측).
   */
  async findEvidenceDetail(
    evidenceId: string,
    lang: SupportedLang,
  ): Promise<{
    chunk: EvidenceChunkRow;
    section: GuidelineSectionRow;
    version: GuidelineVersionRow;
    guideline: GuidelineRow;
    translation?: EvidenceChunkTranslationRow | null;
  } | null> {
    const rows = await this.txManager.conn
      .select({
        chunk: evidenceChunks,
        section: guidelineSections,
        version: guidelineVersions,
        guideline: guidelines,
        translation: evidenceChunkTranslations,
      })
      .from(evidenceChunks)
      .innerJoin(guidelineSections, eq(evidenceChunks.sectionId, guidelineSections.id))
      .innerJoin(guidelineVersions, eq(evidenceChunks.guidelineVersionId, guidelineVersions.id))
      .innerJoin(guidelines, eq(guidelineVersions.guidelineId, guidelines.id))
      .leftJoin(
        evidenceChunkTranslations,
        and(
          eq(evidenceChunkTranslations.chunkId, evidenceChunks.id),
          eq(evidenceChunkTranslations.lang, lang),
        ),
      )
      .where(eq(evidenceChunks.id, evidenceId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 이 페이지의 지침들에 대한 제목 번역 (docs/specs/44 기준 8) — guidelineId → 번역.
   *
   * `mapExistingTitleTranslations`와 원천은 같지만 그쪽은 잡의 표기 고정용이라 **전 코퍼스**를
   * 훑는다. 목록 조회가 매 요청 655행을 groupBy하지 않도록 페이지의 지침만 좁혀 읽는다.
   */
  async mapTitleTranslations(
    guidelineIds: string[],
    lang: SupportedLang,
  ): Promise<Map<string, string>> {
    if (guidelineIds.length === 0) return new Map();

    const rows = await this.txManager.conn
      .select({
        guidelineId: guidelines.id,
        translated: evidenceChunkTranslations.titleTranslated,
        // 변이가 남아 있어도 확정적이도록 다수 표기를 앞에 둔다 (mapExistingTitleTranslations와 같은 규율)
        weight: sql<number>`count(*)::int`,
      })
      .from(evidenceChunkTranslations)
      .innerJoin(evidenceChunks, eq(evidenceChunkTranslations.chunkId, evidenceChunks.id))
      .innerJoin(guidelineVersions, eq(evidenceChunks.guidelineVersionId, guidelineVersions.id))
      .innerJoin(guidelines, eq(guidelineVersions.guidelineId, guidelines.id))
      .where(
        and(
          inArray(guidelines.id, guidelineIds),
          eq(evidenceChunkTranslations.lang, lang),
          isNotNull(evidenceChunkTranslations.titleTranslated),
        ),
      )
      .groupBy(guidelines.id, evidenceChunkTranslations.titleTranslated)
      .orderBy(guidelines.id, desc(sql`count(*)`));

    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.translated !== null && !map.has(row.guidelineId)) {
        map.set(row.guidelineId, row.translated);
      }
    }
    return map;
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
  ): Promise<
    {
      chunk: EvidenceChunkRow;
      guidelineTitle: string;
      sectionPath: string[];
      /** 번역이 없거나 원문이 개정됐다 — 본문을 다시 써야 한다 */
      bodyStale: boolean;
      /** 본문은 최신인데 섹션 경로만 비었다 — 경로만 채우면 된다 */
      pathMissing: boolean;
    }[]
  > {
    const normalizedTitle = sql`btrim(${guidelines.title}, E' \t\n\r')`;
    const scoped = titlePrefixes
      ? or(...titlePrefixes.map((prefix) => sql`${normalizedTitle} LIKE ${`${prefix}%`}`))
      : undefined;

    const rows = await this.txManager.conn
      .select({
        chunk: evidenceChunks,
        guidelineTitle: guidelines.title,
        sectionPath: guidelineSections.path,
        translationHash: evidenceChunkTranslations.sourceContentHash,
        translatedPath: evidenceChunkTranslations.sectionPathTranslated,
      })
      .from(evidenceChunks)
      .innerJoin(guidelineSections, eq(evidenceChunks.sectionId, guidelineSections.id))
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

    return rows.map((row) => {
      /**
       * **두 축을 분리해 낸다** — 하나로 뭉치면 소비 쪽이 구분할 수 없다.
       *
       * 번역이 없거나(null) 원문이 개정돼 해시가 갈린 것은 「본문을 다시 써야 한다」이고,
       * 섹션 경로만 비어 있는 것은 「경로만 채우면 된다」다(docs/specs/44가 새 컬럼을 넣으며
       * 생긴 상태). 뭉쳐 놓으면 경로 하나 때문에 청크 전문이 외부 호출을 타고, 경로 번역이
       * 계속 실패하는 청크는 **매 실행마다 본문을 재번역**하는 고리에 갇힌다.
       */
      const bodyStale = row.translationHash !== row.chunk.contentHash;
      return {
        chunk: row.chunk,
        guidelineTitle: row.guidelineTitle,
        sectionPath: row.sectionPath,
        bodyStale,
        pathMissing: !bodyStale && row.translatedPath === null,
      };
    });
  }

  /**
   * 섹션 경로 번역만 갱신한다 — 본문 provenance를 건드리지 않는다.
   *
   * `upsertChunkTranslation`을 재사용할 수 없다: 그쪽 `set`은 `content`·`translator_model`·
   * `source_content_hash`·`translated_at`을 함께 덮으므로, 경로를 더하려다 그 행의 **본문이
   * 어느 모델로 언제 만들어졌는지**를 지우게 된다.
   */
  async updateSectionPathTranslation(
    chunkId: string,
    lang: SupportedLang,
    sectionPathTranslated: string[],
  ): Promise<void> {
    await this.txManager.conn
      .update(evidenceChunkTranslations)
      .set({ sectionPathTranslated })
      .where(
        and(
          eq(evidenceChunkTranslations.chunkId, chunkId),
          eq(evidenceChunkTranslations.lang, lang),
        ),
      );
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
          sectionPathTranslated: row.sectionPathTranslated ?? null,
          sourceContentHash: row.sourceContentHash,
          translatorModel: row.translatorModel,
          translatedAt: new Date(),
        },
      });
  }

  /**
   * 이미 적재된 지침 제목 번역 (docs/specs/42) — **실행 간 표기를 고정하는 씨앗**이다.
   *
   * 잡의 제목 캐시가 실행 단위라, 재실행이 빈 캐시로 시작하면 같은 제목을 다시 번역하고 LLM이
   * 다른 표기를 낸다(실측: 편두통이 「Migraine Korean Medicine…」 125건 대 「…for Migraine」
   * 5건으로 갈렸다). 개정 실행은 그 지침의 **일부 청크만** 건드리므로, 고치지 않으면 한 지침이
   * 두 영문 제목으로 불리고 같은 답변의 인용 카드끼리 어긋난다.
   *
   * **키가 지침 id가 아니라 제목 문자열인 이유**: id로 잡으면 제목이 개정으로 바뀌어도 옛 번역을
   * 재사용한다. 문자열로 잡으면 제목이 바뀐 순간 캐시 미스가 나 자동으로 다시 번역된다 —
   * `source_content_hash`가 본문에 대해 하는 일과 같은 원리다.
   *
   * 변이가 이미 남아 있어도 확정적이도록 **다수결**로 하나를 고른다.
   */
  async mapExistingTitleTranslations(lang: string): Promise<Map<string, string>> {
    const normalizedTitle = sql<string>`btrim(${guidelines.title}, E' \t\n\r')`;
    const rows = await this.txManager.conn
      .select({
        title: normalizedTitle,
        translated: evidenceChunkTranslations.titleTranslated,
      })
      .from(evidenceChunkTranslations)
      .innerJoin(evidenceChunks, eq(evidenceChunkTranslations.chunkId, evidenceChunks.id))
      .innerJoin(guidelineVersions, eq(evidenceChunks.guidelineVersionId, guidelineVersions.id))
      .innerJoin(guidelines, eq(guidelineVersions.guidelineId, guidelines.id))
      .where(
        and(
          eq(evidenceChunkTranslations.lang, lang),
          isNotNull(evidenceChunkTranslations.titleTranslated),
        ),
      )
      .groupBy(normalizedTitle, evidenceChunkTranslations.titleTranslated)
      .orderBy(normalizedTitle, desc(sql`count(*)`));

    // orderBy가 제목별로 다수 표기를 앞에 두므로, 처음 본 것만 담으면 다수결이 된다
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.translated !== null && !map.has(row.title)) map.set(row.title, row.translated);
    }
    return map;
  }

  // ── 키워드 어휘 (docs/specs/45) ────────────────────────
  //
  // 판본 단위 어절 산출은 SQL이 아니라 서비스에서 토크나이저로 한다 — 질의와 **같은 함수**를
  // 태워야 축이 갈리지 않는다(#402가 무너진 자리). 여기는 읽기·집합 연산만 맡는다.

  /** 어휘 전건 로드 — 질의 시점 조회가 없으므로 이 경로 하나로만 읽힌다 */
  async loadVocabTerms(): Promise<{ term: string; chunkIxs: number[] }[]> {
    return this.txManager.conn
      .select({ term: keywordVocab.term, chunkIxs: keywordVocab.chunkIxs })
      .from(keywordVocab);
  }

  /** ix → chunk id 해석표 전건 로드 */
  async loadChunkIndex(): Promise<{ chunkId: string; ix: number }[]> {
    return this.txManager.conn
      .select({ chunkId: keywordChunkIndex.chunkId, ix: keywordChunkIndex.ix })
      .from(keywordChunkIndex);
  }

  /**
   * 판본이 이미 발급받은 ix — 제거 경로 전용 **읽기**다.
   *
   * 제거에 `assignChunkIxs`를 쓰면 어휘에서 빼려는 판본에 새 ix를 발급하게 된다(구멍만 늘고
   * 뺄 대상은 못 찾는다). ACTIVE였던 적이 없는 판본은 여기서 빈 배열이 나오고, 그때 제거는
   * 정확히 아무것도 하지 않는 것이 옳다.
   */
  async listVersionChunkIxs(versionId: string): Promise<number[]> {
    const rows = await this.txManager.conn
      .select({ ix: keywordChunkIndex.ix })
      .from(keywordChunkIndex)
      .innerJoin(evidenceChunks, eq(evidenceChunks.id, keywordChunkIndex.chunkId))
      .where(eq(evidenceChunks.guidelineVersionId, versionId));
    return rows.map((row) => row.ix);
  }

  /** 판본의 청크 (id·본문) — 어절 산출 입력 */
  async listVersionChunkContents(versionId: string): Promise<{ id: string; content: string }[]> {
    return this.txManager.conn
      .select({ id: evidenceChunks.id, content: evidenceChunks.content })
      .from(evidenceChunks)
      .where(eq(evidenceChunks.guidelineVersionId, versionId));
  }

  /** ACTIVE 판본의 청크 전건 (id·본문) — 전량 재생성 입력. 어휘는 ACTIVE 경계로 정의된다 */
  async listActiveChunkContents(): Promise<{ id: string; content: string }[]> {
    return this.txManager.conn
      .select({ id: evidenceChunks.id, content: evidenceChunks.content })
      .from(evidenceChunks)
      .innerJoin(guidelineVersions, eq(evidenceChunks.guidelineVersionId, guidelineVersions.id))
      .where(eq(guidelineVersions.status, 'ACTIVE'))
      .orderBy(asc(evidenceChunks.id));
  }

  /**
   * ix가 없는 청크에만 발급하고 전체 매핑을 돌려준다.
   *
   * **발급은 append-only다** — 컬럼이 identity 시퀀스이므로 `onConflictDoNothing`이 만드는
   * 구멍은 되감기지 않는다. `max(ix)+1`로 직접 계산하면 최대 ix를 가진 청크가 삭제될 때 그
   * 번호가 재발급되어 포스팅이 남의 청크를 가리킨다.
   */
  async assignChunkIxs(chunkIds: string[]): Promise<Map<string, number>> {
    if (chunkIds.length === 0) return new Map();

    for (const batch of chunked(chunkIds, VOCAB_WRITE_BATCH)) {
      await this.txManager.conn
        .insert(keywordChunkIndex)
        .values(batch.map((chunkId) => ({ chunkId })))
        .onConflictDoNothing();
    }

    const assigned = new Map<string, number>();
    for (const batch of chunked(chunkIds, VOCAB_WRITE_BATCH)) {
      const rows = await this.txManager.conn
        .select({ chunkId: keywordChunkIndex.chunkId, ix: keywordChunkIndex.ix })
        .from(keywordChunkIndex)
        .where(inArray(keywordChunkIndex.chunkId, batch));
      for (const row of rows) assigned.set(row.chunkId, row.ix);
    }
    return assigned;
  }

  /** 항별 포스팅 **합집합** upsert — 정렬·중복 제거된 집합으로 정규화한다 */
  async mergeVocabPostings(entries: { term: string; chunkIxs: number[] }[]): Promise<void> {
    for (const batch of chunked(entries, VOCAB_WRITE_BATCH)) {
      await this.txManager.conn
        .insert(keywordVocab)
        .values(
          batch.map((entry) => ({
            term: entry.term,
            chunkIxs: normalizeIxs(entry.chunkIxs),
          })),
        )
        .onConflictDoUpdate({
          target: keywordVocab.term,
          set: {
            // 덮어쓰기가 아니라 합집합이다 — 같은 어절이 여러 판본에 걸쳐 있으면
            // 판본 하나를 적재해도 다른 판본의 포스팅이 남아야 한다 (기준 18)
            chunkIxs: sql`(
              SELECT COALESCE(array_agg(ix ORDER BY ix), '{}'::int[])
              FROM (
                SELECT DISTINCT unnest(${keywordVocab.chunkIxs} || excluded.chunk_ixs) AS ix
              ) AS merged
            )`,
            updatedAt: new Date(),
          },
        });
    }
  }

  /** 포스팅에서 ix들을 뺀다. 비게 된 항은 행째 지운다 — 빈 포스팅은 DF 0인 유령 항이다 */
  async subtractVocabPostings(chunkIxs: number[]): Promise<void> {
    if (chunkIxs.length === 0) return;

    // `sql.param`으로 **배열 하나**를 묶어 보낸다 — 그냥 보간하면 drizzle이 원소마다 placeholder를
    // 펼쳐 `$1, $2::int[]`가 되고 드라이버가 "malformed array literal"로 죽는다.
    const removed = sql`${sql.param(chunkIxs)}::int[]`;
    await this.txManager.conn.execute(sql`
      UPDATE ${keywordVocab}
      SET chunk_ixs = COALESCE((
            SELECT array_agg(ix ORDER BY ix)
            FROM unnest(${keywordVocab.chunkIxs}) AS ix
            WHERE NOT (ix = ANY(${removed}))
          ), '{}'::int[]),
          updated_at = now()
      WHERE ${keywordVocab.chunkIxs} && ${removed}
    `);
    await this.txManager.conn
      .delete(keywordVocab)
      .where(sql`cardinality(${keywordVocab.chunkIxs}) = 0`);
  }

  /**
   * 전량 재생성 — 어휘만 비우고 다시 채운다. **`keyword_chunk_index`는 건드리지 않는다**:
   * ix를 재배정하면 살아 있는 앱 프로세스의 인메모리 포스팅이 남의 청크를 가리킨다
   * (캐시 무효화가 프로세스 경계를 못 넘는다 — spec 45 위험 ⑶).
   *
   * 비우기와 채우기가 한 트랜잭션이어야 중간 실패가 어휘를 반쪽으로 남기지 않는다.
   */
  async replaceVocab(entries: { term: string; chunkIxs: number[] }[]): Promise<void> {
    await this.txManager.run(async () => {
      await this.txManager.conn.delete(keywordVocab);
      await this.mergeVocabPostings(entries);
    });
  }
}

/** 포스팅 정규화 — 정렬·중복 제거. 증분 결과를 전량 재생성과 직접 대조하려면 표현이 하나여야 한다 */
function normalizeIxs(chunkIxs: number[]): number[] {
  return [...new Set(chunkIxs)].sort((left, right) => left - right);
}

/** 어휘는 판본당 수천 항이라 한 문장에 다 싣지 않는다 — 파라미터 상한과 계획 시간이 함께 는다 */
const VOCAB_WRITE_BATCH = 1000;

function chunked<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    batches.push(values.slice(start, start + size));
  }
  return batches;
}
