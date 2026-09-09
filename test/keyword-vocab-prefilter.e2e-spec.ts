// docs/specs/45 수용 기준 1~2·14~23 동결 테스트 — 구현 중 수정 금지
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GuidelineAdminService } from '../src/domain/guideline/service/guideline-admin.service';
import { GuidelineIngestInput } from '../src/domain/guideline/service/guideline-ingest.input';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { KeywordVocabularyService } from '../src/domain/guideline/service/keyword-vocabulary.service';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import {
  RERANKER,
  RerankCandidate,
  Reranker,
  RerankResult,
} from '../src/infrastructure/retrieval/reranker.port';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import {
  keywordVocabCorpus,
  singleChunkGuideline,
} from './fixtures/keyword-vocab-samples';
import { socialSignUp } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const KEYWORD_BUDGET = 75;

interface VocabRow {
  term: string;
  chunkIxs: number[];
}

interface ChunkIndexRow {
  chunkId: string;
  ix: number;
}

class RecordingReranker implements Reranker {
  constructor(readonly model: string) {}

  rerank(
    _question: string,
    candidates: RerankCandidate[],
  ): Promise<RerankResult> {
    return Promise.resolve({
      order: candidates.map((candidate) => candidate.chunkId),
      top1Relevance: 10,
    });
  }
}

const failingVocabulary = {
  selectCandidates: jest.fn().mockResolvedValue({ tokens: [], chunkIds: null }),
  applyVersion: jest
    .fn()
    .mockRejectedValue(new Error('의도된 어휘 applyVersion 실패')),
  removeVersion: jest
    .fn()
    .mockRejectedValue(new Error('의도된 어휘 removeVersion 실패')),
  invalidate: jest.fn(),
  rebuildAll: jest.fn().mockResolvedValue({ terms: 0, postings: 0, chunks: 0 }),
};

function normalizedVocab(rows: VocabRow[]): VocabRow[] {
  return rows
    .map((row) => ({
      term: row.term,
      chunkIxs: [...row.chunkIxs].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.term.localeCompare(b.term));
}

function normalizedIndex(rows: ChunkIndexRow[]): ChunkIndexRow[] {
  return [...rows].sort((a, b) => a.chunkId.localeCompare(b.chunkId));
}

describe('spec 45: 키워드 arm 어휘 프리필터', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let failureApp: INestApplication;
  let adminCookie: string;

  const recordingReranker = new RecordingReranker(
    'vocab-recording-reranker-test',
  );

  const createApp = async (
    vocabularyOverride?: typeof failingVocabulary,
  ): Promise<INestApplication> => {
    let builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(RERANKER)
      .useValue(recordingReranker);
    if (vocabularyOverride) {
      builder = builder
        .overrideProvider(KeywordVocabularyService)
        .useValue(vocabularyOverride);
    }
    const moduleRef = await builder.compile();
    const created = moduleRef.createNestApplication();
    created.setGlobalPrefix('api/v1');
    created.use(cookieParser());
    await bootstrapApp(created);
    return created;
  };

  beforeAll(async () => {
    [container, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    app = await createApp();
    failureApp = await createApp(failingVocabulary);

    const admin = await socialSignUp(app, {
      email: 'spec45-admin@clinic.kr',
      providerId: 'spec45-admin',
      clinicName: '스펙45 관리자 한의원',
      licenseNumber: 'SPEC-4501',
    });
    adminCookie = admin.cookie;
    await pool.query(`UPDATE clinicians SET role = 'ADMIN' WHERE id = $1`, [
      admin.clinicianId,
    ]);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        keyword_vocab,
        keyword_chunk_index,
        message_citations,
        generation_runs,
        answer_feedbacks,
        messages,
        conversations,
        evidence_chunks,
        guideline_sections,
        guideline_versions,
        guidelines,
        pipeline_runs,
        guideline_jobs,
        source_documents
      RESTART IDENTITY CASCADE
    `);

    try {
      app.get(KeywordVocabularyService).invalidate();
    } catch {
      // 현재 스텁의 throw는 개별 RED 테스트에서 관찰한다. 격리 정리는 다음 테스트를 막지 않는다.
    }
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await failureApp?.close();
    await app?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  const ingest = (
    input: GuidelineIngestInput,
    target: INestApplication = app,
  ) => target.get(GuidelineIngestService).ingest(input);

  const vocabRows = async (): Promise<VocabRow[]> => {
    const result = await pool.query<VocabRow>(`
      SELECT term, chunk_ixs AS "chunkIxs"
      FROM keyword_vocab
      ORDER BY term
    `);
    return result.rows;
  };

  const chunkIndexRows = async (): Promise<ChunkIndexRow[]> => {
    const result = await pool.query<ChunkIndexRow>(`
      SELECT chunk_id AS "chunkId", ix
      FROM keyword_chunk_index
      ORDER BY chunk_id
    `);
    return result.rows;
  };

  const vocabTerm = async (term: string): Promise<VocabRow | undefined> => {
    const result = await pool.query<VocabRow>(
      `
        SELECT term, chunk_ixs AS "chunkIxs"
        FROM keyword_vocab
        WHERE term = $1
      `,
      [term],
    );
    return result.rows[0];
  };

  const chunkIdsForVersion = async (versionId: string): Promise<string[]> => {
    const result = await pool.query<{ id: string }>(
      `
        SELECT id
        FROM evidence_chunks
        WHERE guideline_version_id = $1
        ORDER BY id
      `,
      [versionId],
    );
    return result.rows.map((row) => row.id);
  };

  const patchStatus = async (
    versionId: string,
    status: 'ACTIVE' | 'SUPERSEDED',
  ): Promise<void> => {
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/guideline-versions/${versionId}`)
      .set(CSRF)
      .set('Cookie', adminCookie)
      .send({ status })
      .expect(200);
  };

  describe('A. 어휘가 매칭과 같은 축으로 선다', () => {
    it("기준 1a: 서비스의 부분문자열 DF는 DB content ILIKE '%토큰%' 청크 수와 같다", async () => {
      await ingest(keywordVocabCorpus);
      const token = '임상';
      const selected = await app
        .get(KeywordVocabularyService)
        .selectCandidates(token, KEYWORD_BUDGET);
      const ilike = await pool.query<{ count: number }>(
        `
          SELECT count(DISTINCT ec.id)::int AS count
          FROM evidence_chunks ec
          INNER JOIN guideline_versions gv
            ON gv.id = ec.guideline_version_id
          WHERE gv.status = 'ACTIVE'
            AND ec.content ILIKE '%' || $1 || '%'
        `,
        [token],
      );

      expect(ilike.rows[0].count).toBe(2);
      expect(selected.tokens).toContainEqual({
        token: '임상',
        df: ilike.rows[0].count,
        common: false,
      });
    });

    it('기준 1b: 여러 어휘 항의 겹치는 포스팅은 단순 합이 아니라 합집합 DF로 센다', async () => {
      await ingest(keywordVocabCorpus);
      const token = '임상';
      const matchingTerms = await pool.query<VocabRow>(
        `
          SELECT term, chunk_ixs AS "chunkIxs"
          FROM keyword_vocab
          WHERE term ILIKE '%' || $1 || '%'
          ORDER BY term
        `,
        [token],
      );
      const ilike = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM evidence_chunks WHERE content ILIKE '%' || $1 || '%'`,
        [token],
      );
      const selected = await app
        .get(KeywordVocabularyService)
        .selectCandidates(token, KEYWORD_BUDGET);
      const tokenSelection = selected.tokens.find(
        (candidate) => candidate.token === token,
      );
      const simplePostingSum = matchingTerms.rows.reduce(
        (sum, row) => sum + row.chunkIxs.length,
        0,
      );

      expect(matchingTerms.rows.map((row) => row.term).sort()).toEqual(
        ['비임상시험', '임상연구', '임상적'].sort(),
      );
      expect(simplePostingSum).toBe(3);
      expect(ilike.rows[0].count).toBe(2);
      expect(simplePostingSum).toBeGreaterThan(ilike.rows[0].count);
      expect(tokenSelection?.df).toBe(ilike.rows[0].count);
    });

    it('기준 2a: ACTIVE 판본에만 있는 raw 어절은 keyword_vocab에 있다', async () => {
      await ingest(
        singleChunkGuideline('active-only', '활성전용어 합성근거문장'),
      );

      expect(await vocabTerm('활성전용어')).toEqual({
        term: '활성전용어',
        chunkIxs: [expect.any(Number)],
      });
    });

    it('기준 2b: 관리자 PATCH로 ACTIVE에서 내린 판본의 전용 어절은 어휘에서 빠진다', async () => {
      const created = await ingest(
        singleChunkGuideline('admin-supersede', '관리자전용어 합성근거문장'),
      );
      expect(await vocabTerm('관리자전용어')).toBeDefined();

      await patchStatus(created.guidelineVersionId, 'SUPERSEDED');

      expect(await vocabTerm('관리자전용어')).toBeUndefined();
    });

    it('기준 2b: 같은 판본 재인제스트로 자동 SUPERSEDED된 이전 revision 어절도 빠진다', async () => {
      const firstInput = singleChunkGuideline(
        'revision-supersede',
        '구판전용어 합성근거문장',
      );
      const first = await ingest(firstInput);
      expect(await vocabTerm('구판전용어')).toBeDefined();

      const second = await ingest({
        ...firstInput,
        sections: [
          {
            ...firstInput.sections[0],
            chunks: [{ content: '신판전용어 합성근거문장' }],
          },
        ],
      });
      const statuses = await pool.query<{ id: string; status: string }>(
        `
          SELECT id, status::text AS status
          FROM guideline_versions
          WHERE id = ANY($1::text[])
          ORDER BY revision
        `,
        [[first.guidelineVersionId, second.guidelineVersionId]],
      );

      expect(statuses.rows).toEqual([
        { id: first.guidelineVersionId, status: 'SUPERSEDED' },
        { id: second.guidelineVersionId, status: 'ACTIVE' },
      ]);
      expect(await vocabTerm('구판전용어')).toBeUndefined();
      expect(await vocabTerm('신판전용어')).toBeDefined();
    });
  });

  describe('C. 코퍼스 변경의 증분 어휘 갱신', () => {
    it('기준 14: 인제스트한 판본 전용 어절의 포스팅이 그 새 청크를 후보로 가리킨다', async () => {
      await ingest(keywordVocabCorpus);
      const vocabulary = app.get(KeywordVocabularyService);
      const before = await vocabulary.selectCandidates('새판본전용어', KEYWORD_BUDGET);
      expect(before.tokens).toEqual([
        { token: '새판본전용어', df: 0, common: false },
      ]);
      const created = await ingest(
        singleChunkGuideline('new-ingest-vocab', '새판본전용어 합성근거문장'),
      );
      const [chunkId] = await chunkIdsForVersion(created.guidelineVersionId);
      const selected = await vocabulary.selectCandidates('새판본전용어', KEYWORD_BUDGET);

      expect(await vocabTerm('새판본전용어')).toBeDefined();
      expect(selected.tokens).toEqual([
        { token: '새판본전용어', df: 1, common: false },
      ]);
      expect(selected.chunkIds).toEqual([chunkId]);
    });

    it('기준 15: updateVersionStatus ACTIVE → SUPERSEDED는 판본 전용 어절을 뺀다', async () => {
      const created = await ingest(
        singleChunkGuideline('status-remove', '상태이탈전용어 합성근거문장'),
      );
      const vocabulary = app.get(KeywordVocabularyService);
      expect(await vocabTerm('상태이탈전용어')).toBeDefined();
      expect(
        (await vocabulary.selectCandidates('상태이탈전용어', KEYWORD_BUDGET)).tokens[0].df,
      ).toBe(1);

      await patchStatus(created.guidelineVersionId, 'SUPERSEDED');

      expect(await vocabTerm('상태이탈전용어')).toBeUndefined();
      expect(
        (await vocabulary.selectCandidates('상태이탈전용어', KEYWORD_BUDGET)).tokens[0].df,
      ).toBe(0);
    });

    it('기준 16: updateVersionStatus SUPERSEDED → ACTIVE는 판본 어절을 다시 넣는다', async () => {
      const created = await ingest(
        singleChunkGuideline('status-restore', '상태복귀전용어 합성근거문장'),
      );
      const vocabulary = app.get(KeywordVocabularyService);
      expect(await vocabTerm('상태복귀전용어')).toBeDefined();
      expect(
        (await vocabulary.selectCandidates('상태복귀전용어', KEYWORD_BUDGET)).tokens[0].df,
      ).toBe(1);
      await patchStatus(created.guidelineVersionId, 'SUPERSEDED');
      expect(await vocabTerm('상태복귀전용어')).toBeUndefined();
      expect(
        (await vocabulary.selectCandidates('상태복귀전용어', KEYWORD_BUDGET)).tokens[0].df,
      ).toBe(0);

      await patchStatus(created.guidelineVersionId, 'ACTIVE');

      expect(await vocabTerm('상태복귀전용어')).toBeDefined();
      expect(
        (await vocabulary.selectCandidates('상태복귀전용어', KEYWORD_BUDGET)).tokens[0].df,
      ).toBe(1);
    });

    it('기준 17: deleteVersion은 삭제 판본 전용 어절을 어휘에서 뺀다', async () => {
      const created = await ingest(
        singleChunkGuideline('delete-vocab', '삭제판본전용어 합성근거문장'),
      );
      const vocabulary = app.get(KeywordVocabularyService);
      expect(await vocabTerm('삭제판본전용어')).toBeDefined();
      expect(
        (await vocabulary.selectCandidates('삭제판본전용어', KEYWORD_BUDGET)).tokens[0].df,
      ).toBe(1);

      await app
        .get(GuidelineAdminService)
        .deleteVersion(created.guidelineVersionId);

      expect(await vocabTerm('삭제판본전용어')).toBeUndefined();
      expect(
        (await vocabulary.selectCandidates('삭제판본전용어', KEYWORD_BUDGET)).tokens[0].df,
      ).toBe(0);
    });

    it('기준 18: 한 ACTIVE 판본을 내려도 공유 어절은 다른 포스팅에 남고 전용 어절만 빠진다', async () => {
      const first = await ingest(
        singleChunkGuideline(
          'shared-a',
          '공유존재어 첫판본전용어 합성근거문장',
        ),
      );
      const second = await ingest(
        singleChunkGuideline(
          'shared-b',
          '공유존재어 둘판본전용어 합성근거문장',
        ),
      );
      const [secondChunk] = await chunkIdsForVersion(second.guidelineVersionId);
      const secondIndex = (await chunkIndexRows()).find(
        (row) => row.chunkId === secondChunk,
      );
      const vocabulary = app.get(KeywordVocabularyService);
      expect(await vocabTerm('공유존재어')).toBeDefined();
      expect(await vocabTerm('첫판본전용어')).toBeDefined();
      expect(secondIndex).toBeDefined();
      const before = await vocabulary.selectCandidates(
        '공유존재어 첫판본전용어',
        KEYWORD_BUDGET,
      );
      expect(before.tokens.map(({ token, df }) => ({ token, df }))).toEqual([
        { token: '공유존재어', df: 2 },
        { token: '첫판본전용어', df: 1 },
      ]);

      await patchStatus(first.guidelineVersionId, 'SUPERSEDED');

      const after = await vocabulary.selectCandidates(
        '공유존재어 첫판본전용어',
        KEYWORD_BUDGET,
      );
      expect(await vocabTerm('첫판본전용어')).toBeUndefined();
      expect(await vocabTerm('둘판본전용어')).toBeDefined();
      expect(await vocabTerm('공유존재어')).toEqual({
        term: '공유존재어',
        chunkIxs: [secondIndex?.ix as number],
      });
      expect(after.tokens.map(({ token, df }) => ({ token, df }))).toEqual([
        { token: '공유존재어', df: 1 },
        { token: '첫판본전용어', df: 0 },
      ]);
    });

    it('기준 19a: 증분 갱신의 term 집합은 ACTIVE 코퍼스 전량 재생성과 같다', async () => {
      await ingest(keywordVocabCorpus);
      const removable = await ingest(
        singleChunkGuideline('incremental-term', '증분제거전용어 공유증분어'),
      );
      await ingest(
        singleChunkGuideline('incremental-keep', '증분유지전용어 공유증분어'),
      );
      await patchStatus(removable.guidelineVersionId, 'SUPERSEDED');
      const incrementalTerms = (await vocabRows()).map((row) => row.term).sort();
      expect(incrementalTerms.length).toBeGreaterThan(0);

      await app.get(KeywordVocabularyService).rebuildAll();
      const rebuiltTerms = (await vocabRows()).map((row) => row.term).sort();

      expect(rebuiltTerms).toEqual(incrementalTerms);
      expect(rebuiltTerms).not.toContain('증분제거전용어');
      expect(rebuiltTerms).toContain('증분유지전용어');
      expect(rebuiltTerms).toContain('공유증분어');
    });

    it('기준 19b: 증분 갱신의 항별 chunk_ixs는 ix를 보존한 전량 재생성과 같다', async () => {
      await ingest(keywordVocabCorpus);
      const removable = await ingest(
        singleChunkGuideline('incremental-posting', '포스팅제거전용어 공유포스팅어'),
      );
      await ingest(
        singleChunkGuideline('incremental-posting-keep', '포스팅유지전용어 공유포스팅어'),
      );
      await patchStatus(removable.guidelineVersionId, 'SUPERSEDED');
      const incremental = normalizedVocab(await vocabRows());
      expect(incremental.length).toBeGreaterThan(0);

      await app.get(KeywordVocabularyService).rebuildAll();
      const rebuilt = normalizedVocab(await vocabRows());

      expect(rebuilt).toEqual(incremental);
    });

    it('기준 20a: applyVersion 어휘 갱신 실패는 인제스트 요청 자체를 실패시킨다', async () => {
      const input = singleChunkGuideline(
        'failed-ingest-request',
        '실패인제스트전용어 합성근거문장',
      );

      await expect(ingest(input, failureApp)).rejects.toThrow(
        '의도된 어휘 applyVersion 실패',
      );
      expect(failingVocabulary.applyVersion).toHaveBeenCalledTimes(1);
    });

    it('기준 20b: applyVersion 실패 시 같은 트랜잭션의 새 판본·청크도 남지 않는다', async () => {
      const input = singleChunkGuideline(
        'failed-ingest-rollback',
        '롤백인제스트전용어 합성근거문장',
      );
      await expect(ingest(input, failureApp)).rejects.toThrow(
        '의도된 어휘 applyVersion 실패',
      );

      const stored = await pool.query<{ versions: number; chunks: number }>(`
        SELECT
          (SELECT count(*)::int FROM guideline_versions gv
           INNER JOIN guidelines g ON g.id = gv.guideline_id
           WHERE g.title = 'failed-ingest-rollback 합성 지침') AS versions,
          (SELECT count(*)::int FROM evidence_chunks ec
           WHERE ec.content ILIKE '%롤백인제스트전용어%') AS chunks
      `);
      expect(stored.rows[0]).toEqual({ versions: 0, chunks: 0 });
    });

    it('기준 21: removeVersion 실패 시 updateVersionStatus 트랜잭션이 status를 ACTIVE로 되돌린다', async () => {
      const created = await ingest(
        singleChunkGuideline('failed-status', '상태롤백전용어 합성근거문장'),
      );

      await expect(
        failureApp.get(GuidelineAdminService).updateVersionStatus(
          created.guidelineVersionId,
          { status: 'SUPERSEDED' },
        ),
      ).rejects.toThrow('의도된 어휘 removeVersion 실패');
      const status = await pool.query<{ status: string }>(
        `SELECT status::text AS status FROM guideline_versions WHERE id = $1`,
        [created.guidelineVersionId],
      );

      expect(status.rows).toEqual([{ status: 'ACTIVE' }]);
    });

    it('기준 22: 최대 ix 청크를 삭제한 뒤 넣은 새 청크도 그 삭제 ix를 재사용하지 않는다', async () => {
      const first = await ingest(
        singleChunkGuideline('ix-first', '첫인덱스전용어 합성근거문장'),
      );
      const second = await ingest(
        singleChunkGuideline('ix-second', '둘인덱스전용어 합성근거문장'),
      );
      const indexed = await pool.query<
        ChunkIndexRow & { versionId: string }
      >(`
        SELECT
          kci.chunk_id AS "chunkId",
          kci.ix,
          ec.guideline_version_id AS "versionId"
        FROM keyword_chunk_index kci
        INNER JOIN evidence_chunks ec ON ec.id = kci.chunk_id
        WHERE ec.guideline_version_id = ANY($1::text[])
        ORDER BY kci.ix
      `, [[first.guidelineVersionId, second.guidelineVersionId]]);
      expect(indexed.rows).toHaveLength(2);
      const deletedMaximum = indexed.rows[1];

      await app
        .get(GuidelineAdminService)
        .deleteVersion(deletedMaximum.versionId);
      expect(
        (await chunkIndexRows()).some((row) => row.ix === deletedMaximum.ix),
      ).toBe(false);
      const replacement = await ingest(
        singleChunkGuideline('ix-replacement', '새인덱스전용어 합성근거문장'),
      );
      const [replacementChunk] = await chunkIdsForVersion(
        replacement.guidelineVersionId,
      );
      const replacementIndex = (await chunkIndexRows()).find(
        (row) => row.chunkId === replacementChunk,
      );

      expect(replacementIndex).toBeDefined();
      expect(replacementIndex?.ix).toBeGreaterThan(deletedMaximum.ix);
      expect(replacementIndex?.ix).not.toBe(deletedMaximum.ix);
    });

    it('기준 23a: rebuildAll을 두 번 호출해도 어휘 term과 포스팅 내용이 같다', async () => {
      await ingest(keywordVocabCorpus);
      const before = normalizedVocab(await vocabRows());
      expect(before.length).toBeGreaterThan(0);

      await app.get(KeywordVocabularyService).rebuildAll();
      const first = normalizedVocab(await vocabRows());
      await app.get(KeywordVocabularyService).rebuildAll();
      const second = normalizedVocab(await vocabRows());

      expect(first).toEqual(before);
      expect(second).toEqual(first);
    });

    it('기준 23b: 두 번의 rebuildAll은 구멍이 있는 기존 chunk_id→ix 매핑도 재배정하지 않는다', async () => {
      const first = await ingest(
        singleChunkGuideline('rebuild-ix-a', '재빌드인덱스첫째 합성근거'),
      );
      const middle = await ingest(
        singleChunkGuideline('rebuild-ix-b', '재빌드인덱스둘째 합성근거'),
      );
      await ingest(
        singleChunkGuideline('rebuild-ix-c', '재빌드인덱스셋째 합성근거'),
      );
      expect(await chunkIdsForVersion(first.guidelineVersionId)).toHaveLength(1);
      expect(await chunkIdsForVersion(middle.guidelineVersionId)).toHaveLength(1);
      expect(await chunkIndexRows()).toHaveLength(3);
      await app
        .get(GuidelineAdminService)
        .deleteVersion(middle.guidelineVersionId);
      const before = normalizedIndex(await chunkIndexRows());
      expect(before).toHaveLength(2);

      await app.get(KeywordVocabularyService).rebuildAll();
      const afterFirst = normalizedIndex(await chunkIndexRows());
      await app.get(KeywordVocabularyService).rebuildAll();
      const afterSecond = normalizedIndex(await chunkIndexRows());

      expect(afterFirst).toEqual(before);
      expect(afterSecond).toEqual(before);
    });
  });
});
