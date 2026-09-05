// docs/specs/45 수용 기준 1~24·26~28 동결 테스트 — 구현 중 수정 금지
import { createHash } from 'node:crypto';
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
import { retrievalConfig } from '../src/global/config/retrieval.config';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import {
  RERANKER,
  RerankCandidate,
  Reranker,
  RerankResult,
} from '../src/infrastructure/retrieval/reranker.port';
import { RetrievalService } from '../src/infrastructure/retrieval/retrieval.service';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import {
  BOUNDARY_RARE_TERM,
  COMMON_TERM,
  DirectChunkFixture,
  keywordVocabCorpus,
  originalQueryRankingChunks,
  SINGLETON_RARE_TERM,
  singleChunkGuideline,
  tiedKeywordChunks,
  VOCAB_CORPUS_SIZE,
} from './fixtures/keyword-vocab-samples';
import { socialSignUp } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const DISTANCE_CUTOFF = 2;
const SCORE_CUTOFF = 6;
const RERANK_CANDIDATES = 5;
const VOCAB_RATIO = 0.05;
const EMBEDDING_MODEL = 'fake-embedding-v1';
const RERANK_POLICY =
  'hybrid-rrf60-top5x2-vocab0.05-rerank-vocab-recording-reranker-test-cut2-score6-v5/fake-embedding-v1';
const FALLBACK_POLICY =
  'hybrid-rrf60-top5x2-vocab0.05-cut2-v5/fake-embedding-v1';
const DISABLED_V4_POLICY =
  'hybrid-rrf60-top5x2-rerank-vocab-disabled-reranker-test-cut2-score6-v4/fake-embedding-v1';
const DIRECT_VECTOR =
  '[' + ['1', ...Array.from({ length: 1535 }, () => '0')].join(',') + ']';

interface TestRetrievalConfig {
  distanceCutoff: number;
  rerankEnabled: boolean;
  rerankCandidates: number;
  rerankScoreCutoff: number;
  hybridEnabled: boolean;
  vocabPrefilterEnabled: boolean;
  vocabCommonDfRatio: number;
}

interface SseEvent {
  eventType: string;
  [key: string]: unknown;
}

interface PrometheusLabels {
  [key: string]: string;
}

interface VocabRow {
  term: string;
  chunkIxs: number[];
}

interface ChunkIndexRow {
  chunkId: string;
  ix: number;
}

class RecordingReranker implements Reranker {
  calls = 0;

  constructor(readonly model: string) {}

  rerank(
    _question: string,
    candidates: RerankCandidate[],
  ): Promise<RerankResult> {
    this.calls += 1;
    return Promise.resolve({
      order: candidates.map((candidate) => candidate.chunkId),
      top1Relevance: 10,
    });
  }
}

class ThrowingReranker implements Reranker {
  readonly model = 'vocab-throwing-reranker-test';
  calls = 0;

  rerank(
    _question: string,
    _candidates: RerankCandidate[],
  ): Promise<RerankResult> {
    this.calls += 1;
    return Promise.reject(new Error('의도된 어휘 프리필터 리랭커 오류'));
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

function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as SseEvent);
}

function metricValue(
  body: string,
  metricName: string,
  expectedLabels: PrometheusLabels = {},
): number {
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sample = line.match(/^(\S+)\s+(\S+)/);
    if (!sample) continue;
    const series = sample[1];
    const braceIndex = series.indexOf('{');
    const actualName = braceIndex === -1 ? series : series.slice(0, braceIndex);
    if (actualName !== metricName) continue;

    const labels: PrometheusLabels = {};
    if (braceIndex !== -1) {
      const labelText = series.slice(braceIndex + 1, series.lastIndexOf('}'));
      for (const match of labelText.matchAll(
        /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g,
      )) {
        labels[match[1]] = match[2];
      }
    }

    if (
      !Object.entries(expectedLabels).every(
        ([key, value]) => labels[key] === value,
      )
    ) {
      continue;
    }
    const value = Number(sample[2]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

/** 히스토그램 count를 지정 라벨 값별로 읽어 새 stage 유출까지 검출한다. */
function metricValuesByLabel(
  body: string,
  metricName: string,
  labelName: string,
): Map<string, number> {
  const values = new Map<string, number>();
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sample = line.match(/^(\S+)\s+(\S+)/);
    if (!sample) continue;
    const series = sample[1];
    const braceIndex = series.indexOf('{');
    const actualName = braceIndex === -1 ? series : series.slice(0, braceIndex);
    if (actualName !== metricName) continue;
    const labelText =
      braceIndex === -1
        ? ''
        : series.slice(braceIndex + 1, series.lastIndexOf('}'));
    const label = labelText.match(
      new RegExp(`${labelName}="((?:\\\\.|[^"])*)"`),
    );
    if (!label) continue;
    const value = Number(sample[2]);
    if (Number.isFinite(value)) values.set(label[1], value);
  }
  return values;
}

function terminalEvent(events: SseEvent[]): SseEvent | undefined {
  return events[events.length - 1];
}

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
  let fallbackApp: INestApplication;
  let disabledApp: INestApplication;
  let failureApp: INestApplication;
  let adminCookie: string;
  let answerCookie: string;
  let fallbackCookie: string;
  let disabledCookie: string;
  let requestSequence = 0;

  const recordingReranker = new RecordingReranker(
    'vocab-recording-reranker-test',
  );
  const throwingReranker = new ThrowingReranker();
  const disabledReranker = new RecordingReranker(
    'vocab-disabled-reranker-test',
  );

  const enabledConfig: TestRetrievalConfig = {
    distanceCutoff: DISTANCE_CUTOFF,
    rerankEnabled: true,
    rerankCandidates: RERANK_CANDIDATES,
    rerankScoreCutoff: SCORE_CUTOFF,
    hybridEnabled: true,
    vocabPrefilterEnabled: true,
    vocabCommonDfRatio: VOCAB_RATIO,
  };

  const createApp = async (
    reranker: Reranker,
    config: TestRetrievalConfig,
    vocabularyOverride?: typeof failingVocabulary,
  ): Promise<INestApplication> => {
    let builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(RERANKER)
      .useValue(reranker)
      .overrideProvider(retrievalConfig.KEY)
      .useValue(config);
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

    app = await createApp(recordingReranker, enabledConfig);
    fallbackApp = await createApp(throwingReranker, enabledConfig);
    disabledApp = await createApp(disabledReranker, {
      ...enabledConfig,
      vocabPrefilterEnabled: false,
    });
    failureApp = await createApp(
      recordingReranker,
      enabledConfig,
      failingVocabulary,
    );

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
    answerCookie = (
      await socialSignUp(app, {
        email: 'spec45-answer@clinic.kr',
        providerId: 'spec45-answer',
        clinicName: '스펙45 답변 한의원',
        licenseNumber: 'SPEC-4502',
      })
    ).cookie;
    fallbackCookie = (
      await socialSignUp(fallbackApp, {
        email: 'spec45-fallback@clinic.kr',
        providerId: 'spec45-fallback',
        clinicName: '스펙45 폴백 한의원',
        licenseNumber: 'SPEC-4503',
      })
    ).cookie;
    disabledCookie = (
      await socialSignUp(disabledApp, {
        email: 'spec45-disabled@clinic.kr',
        providerId: 'spec45-disabled',
        clinicName: '스펙45 롤백 한의원',
        licenseNumber: 'SPEC-4504',
      })
    ).cookie;
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

    for (const target of [app, fallbackApp, disabledApp]) {
      try {
        target.get(KeywordVocabularyService).invalidate();
      } catch {
        // 현재 스텁의 throw는 개별 RED 테스트에서 관찰한다. 격리 정리는 다음 테스트를 막지 않는다.
      }
    }
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await failureApp?.close();
    await disabledApp?.close();
    await fallbackApp?.close();
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

  const insertDirectCorpus = async (
    key: string,
    chunks: DirectChunkFixture[],
  ): Promise<{ guidelineId: string; versionId: string }> => {
    const guidelineId = `${key}-guideline`;
    const versionId = `${key}-version`;
    const sectionId = `${key}-section`;
    await pool.query(
      `
        INSERT INTO guidelines (id, title, publisher)
        VALUES ($1, $2, $3)
      `,
      [guidelineId, `${key} 결정 코퍼스`, `${key} 합성 학회`],
    );
    await pool.query(
      `
        INSERT INTO guideline_versions (
          id, guideline_id, version, revision, status,
          published_at, source_url, content_hash
        )
        VALUES ($1, $2, '1.0', 1, 'ACTIVE', $3, $4, $5)
      `,
      [
        versionId,
        guidelineId,
        new Date('2026-09-05T00:00:00.000Z'),
        `https://example.test/spec45/${key}`,
        createHash('sha256').update(`${key}-version`).digest('hex'),
      ],
    );
    await pool.query(
      `
        INSERT INTO guideline_sections (
          id, guideline_version_id, title, path, "order"
        )
        VALUES ($1, $2, $3, $4, 1)
      `,
      [sectionId, versionId, '결정 합성 절', ['1', '결정 합성 절']],
    );
    for (const [index, chunk] of chunks.entries()) {
      await pool.query(
        `
          INSERT INTO evidence_chunks (
            id, section_id, guideline_version_id, content, embedding,
            embedding_model, "order", content_hash
          )
          VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8)
        `,
        [
          chunk.id,
          sectionId,
          versionId,
          chunk.content,
          DIRECT_VECTOR,
          EMBEDDING_MODEL,
          index,
          createHash('sha256')
            .update(`${key}:${chunk.id}:${chunk.content}`)
            .digest('hex'),
        ],
      );
    }
    return { guidelineId, versionId };
  };

  const ingestPairWithTerm = async (
    term: string,
    key: string,
  ): Promise<{
    guidelineA: string;
    guidelineB: string;
    versionA: string;
    versionB: string;
    chunkA: string;
    chunkB: string;
  }> => {
    await ingest(keywordVocabCorpus);
    const first = await ingest(
      singleChunkGuideline(`${key}-a`, `${term} 첫지침전용어`),
    );
    const second = await ingest(
      singleChunkGuideline(`${key}-b`, `${term} 둘지침전용어`),
    );
    const [chunkA] = await chunkIdsForVersion(first.guidelineVersionId);
    const [chunkB] = await chunkIdsForVersion(second.guidelineVersionId);
    return {
      guidelineA: first.guidelineId,
      guidelineB: second.guidelineId,
      versionA: first.guidelineVersionId,
      versionB: second.guidelineVersionId,
      chunkA,
      chunkB,
    };
  };

  const scrapeMetrics = async (target: INestApplication): Promise<string> => {
    const response = await request(target.getHttpServer())
      .get('/api/v1/metrics')
      .expect(200);
    return response.text;
  };

  const createConversation = async (
    target: INestApplication,
    cookie: string,
  ): Promise<string> => {
    const response = await request(target.getHttpServer())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ type: 'GUIDELINE_QA' })
      .expect(201);
    return response.body.data.id as string;
  };

  const ask = async (
    target: INestApplication,
    cookie: string,
    question: string,
    prefix: string,
  ): Promise<SseEvent[]> => {
    requestSequence += 1;
    const conversationId = await createConversation(target, cookie);
    const response = await request(target.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', cookie)
      .send({
        content: question,
        clientRequestId: `${prefix}-${requestSequence}`,
      })
      .expect(200);
    return parseSse(response.text);
  };

  const generationRunCount = async (policy: string): Promise<number> => {
    const result = await pool.query<{ count: string }>(
      `
        SELECT count(*) AS count
        FROM generation_runs
        WHERE retrieval_policy_version = $1
      `,
      [policy],
    );
    return Number(result.rows[0].count);
  };

  describe('A. 어휘가 매칭과 같은 축으로 선다', () => {
    it("기준 1a: 서비스의 부분문자열 DF는 DB content ILIKE '%토큰%' 청크 수와 같다", async () => {
      await ingest(keywordVocabCorpus);
      const token = '임상';
      const selected = await app
        .get(KeywordVocabularyService)
        .selectCandidates(token);
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
        .selectCandidates(token);
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

  describe('B. 후보 생성은 후보만 좁히고 순위는 보존한다', () => {
    it('기준 7: 희소 토큰 포스팅 합집합만 키워드 arm의 순위 대상이 된다', async () => {
      await ingest(keywordVocabCorpus);
      const query = `${COMMON_TERM} ${BOUNDARY_RARE_TERM} ${SINGLETON_RARE_TERM}`;
      const expected = await pool.query<{ id: string }>(
        `
          SELECT id
          FROM evidence_chunks
          WHERE content ILIKE '%' || $1 || '%'
             OR content ILIKE '%' || $2 || '%'
          ORDER BY id
        `,
        [BOUNDARY_RARE_TERM, SINGLETON_RARE_TERM],
      );
      const expectedIds = expected.rows.map((row) => row.id);
      const selected = await app
        .get(KeywordVocabularyService)
        .selectCandidates(query);
      const results = await app
        .get(RetrievalService)
        .searchHybrid(query, undefined, VOCAB_CORPUS_SIZE);
      const keywordIds = results
        .filter((row) => row.keywordRank !== null)
        .map((row) => row.chunk.id)
        .sort();
      const commonOnly = await pool.query<{ id: string }>(
        `
          SELECT id
          FROM evidence_chunks
          WHERE content ILIKE '%' || $1 || '%'
            AND content NOT ILIKE '%' || $2 || '%'
            AND content NOT ILIKE '%' || $3 || '%'
          ORDER BY id
          LIMIT 1
        `,
        [COMMON_TERM, BOUNDARY_RARE_TERM, SINGLETON_RARE_TERM],
      );

      expect(selected.tokens).toEqual([
        { token: COMMON_TERM, df: 4, common: true },
        { token: BOUNDARY_RARE_TERM, df: 2, common: false },
        { token: SINGLETON_RARE_TERM, df: 1, common: false },
      ]);
      expect([...(selected.chunkIds ?? [])].sort()).toEqual(expectedIds);
      expect(keywordIds).toEqual(expectedIds);
      expect(commonOnly.rows).toHaveLength(1);
      expect(keywordIds).not.toContain(commonOnly.rows[0].id);
    });

    it('기준 8: 키워드 순위는 축약 질의가 아닌 원문을 word_similarity의 1번 인자로 쓴다', async () => {
      await insertDirectCorpus('ranking', originalQueryRankingChunks);
      await app.get(KeywordVocabularyService).rebuildAll();
      const originalQuery = `${COMMON_TERM} ${BOUNDARY_RARE_TERM}`;
      const compactQuery = BOUNDARY_RARE_TERM;
      const candidateIds = ['rank-a', 'rank-z'];
      const rawOrder = await pool.query<{ id: string }>(
        `
          SELECT id
          FROM evidence_chunks
          WHERE id = ANY($1::text[])
          ORDER BY word_similarity($2::text, content) DESC, id ASC
        `,
        [candidateIds, originalQuery],
      );
      const compactOrder = await pool.query<{ id: string }>(
        `
          SELECT id
          FROM evidence_chunks
          WHERE id = ANY($1::text[])
          ORDER BY word_similarity($2::text, content) DESC, id ASC
        `,
        [candidateIds, compactQuery],
      );
      const selected = await app
        .get(KeywordVocabularyService)
        .selectCandidates(originalQuery);
      const results = await app
        .get(RetrievalService)
        .searchHybrid(originalQuery, undefined, VOCAB_CORPUS_SIZE);
      const actualKeywordOrder = results
        .filter((row) => row.keywordRank !== null)
        .sort((a, b) => (a.keywordRank ?? 0) - (b.keywordRank ?? 0))
        .map((row) => row.chunk.id);

      expect(rawOrder.rows.map((row) => row.id)).toEqual(['rank-z', 'rank-a']);
      expect(compactOrder.rows.map((row) => row.id)).toEqual([
        'rank-a',
        'rank-z',
      ]);
      expect(rawOrder.rows).not.toEqual(compactOrder.rows);
      expect([...(selected.chunkIds ?? [])].sort()).toEqual(candidateIds);
      expect(actualKeywordOrder).toEqual(rawOrder.rows.map((row) => row.id));
    });

    it('기준 9: word_similarity 동점의 2차 정렬 키는 청크 id 오름차순이다', async () => {
      await insertDirectCorpus('tie', tiedKeywordChunks);
      await app.get(KeywordVocabularyService).rebuildAll();
      const scores = await pool.query<{ id: string; score: number }>(
        `
          SELECT id, word_similarity($1::text, content)::float8 AS score
          FROM evidence_chunks
          WHERE id = ANY($2::text[])
          ORDER BY id
        `,
        ['동점희소', ['tie-a', 'tie-b']],
      );
      const selected = await app
        .get(KeywordVocabularyService)
        .selectCandidates('동점희소');
      const results = await app
        .get(RetrievalService)
        .searchHybrid('동점희소', undefined, VOCAB_CORPUS_SIZE);
      const keywordOrder = results
        .filter((row) => row.keywordRank !== null)
        .sort((a, b) => (a.keywordRank ?? 0) - (b.keywordRank ?? 0))
        .map((row) => row.chunk.id);

      expect(scores.rows.map((row) => row.id)).toEqual(['tie-a', 'tie-b']);
      expect(scores.rows[0].score).toBe(scores.rows[1].score);
      expect([...(selected.chunkIds ?? [])].sort()).toEqual([
        'tie-a',
        'tie-b',
      ]);
      expect(keywordOrder).toEqual(['tie-a', 'tie-b']);
    });

    it('기준 10: 질의 토큰이 전부 흔하면 null 후보로 전량 스캔해 키워드 결과를 낸다', async () => {
      await ingest(keywordVocabCorpus);
      const selected = await app
        .get(KeywordVocabularyService)
        .selectCandidates(COMMON_TERM);
      const results = await app
        .get(RetrievalService)
        .searchHybrid(COMMON_TERM, undefined, VOCAB_CORPUS_SIZE);
      const keywordRows = results.filter((row) => row.keywordRank !== null);

      expect(selected.tokens).toEqual([
        { token: COMMON_TERM, df: 4, common: true },
      ]);
      expect(selected.chunkIds).toBeNull();
      expect(keywordRows).toHaveLength(VOCAB_CORPUS_SIZE);
      expect(
        keywordRows.some((row) => !row.chunk.content.includes(COMMON_TERM)),
      ).toBe(true);
    });

    it('기준 10b: 희소한 미등재 신조어의 포스팅이 0건이어도 전량 스캔으로 돌아간다', async () => {
      await ingest(keywordVocabCorpus);
      const query = '코퍼스밖신조어';
      const selected = await app
        .get(KeywordVocabularyService)
        .selectCandidates(query);
      const results = await app
        .get(RetrievalService)
        .searchHybrid(query, undefined, VOCAB_CORPUS_SIZE);

      expect(selected.tokens).toEqual([
        { token: query, df: 0, common: false },
      ]);
      expect(selected.chunkIds).toBeNull();
      expect(results.filter((row) => row.keywordRank !== null)).toHaveLength(
        VOCAB_CORPUS_SIZE,
      );
    });

    it('기준 11: keyword_vocab가 비어 있는 백필 전 창에도 키워드 arm은 결과를 낸다', async () => {
      const created = await ingest(
        singleChunkGuideline('empty-vocab-window', '백필전검색어 합성근거문장'),
      );
      const [chunkId] = await chunkIdsForVersion(created.guidelineVersionId);
      expect((await vocabRows()).length).toBeGreaterThan(0);
      await pool.query('DELETE FROM keyword_vocab');
      app.get(KeywordVocabularyService).invalidate();

      const selected = await app
        .get(KeywordVocabularyService)
        .selectCandidates('백필전검색어');
      const results = await app
        .get(RetrievalService)
        .searchHybrid('백필전검색어', undefined, RERANK_CANDIDATES);

      expect(selected.chunkIds).toBeNull();
      expect(results.some((row) => row.chunk.id === chunkId)).toBe(true);
      expect(results.some((row) => row.keywordRank !== null)).toBe(true);
    });

    it('기준 12a: 프리필터 후보라도 embedding_model이 다르면 키워드 arm에서 제외한다', async () => {
      const pair = await ingestPairWithTerm('모델경계희소어', 'model-boundary');
      const selected = await app
        .get(KeywordVocabularyService)
        .selectCandidates('모델경계희소어');
      expect([...(selected.chunkIds ?? [])].sort()).toEqual(
        [pair.chunkA, pair.chunkB].sort(),
      );
      await pool.query(
        `UPDATE evidence_chunks SET embedding_model = 'other-embedding-model' WHERE id = $1`,
        [pair.chunkA],
      );

      const results = await app
        .get(RetrievalService)
        .searchHybrid('모델경계희소어', undefined, VOCAB_CORPUS_SIZE);
      const keywordIds = results
        .filter((row) => row.keywordRank !== null)
        .map((row) => row.chunk.id);

      expect(keywordIds).toContain(pair.chunkB);
      expect(keywordIds).not.toContain(pair.chunkA);
      expect(results.map((row) => row.chunk.id)).not.toContain(pair.chunkA);
    });

    it('기준 12b: stale 후보에 남아 있어도 ACTIVE가 아닌 판본 청크는 키워드 arm에서 제외한다', async () => {
      const pair = await ingestPairWithTerm('상태경계희소어', 'status-boundary');
      const selected = await app
        .get(KeywordVocabularyService)
        .selectCandidates('상태경계희소어');
      expect([...(selected.chunkIds ?? [])].sort()).toEqual(
        [pair.chunkA, pair.chunkB].sort(),
      );
      // 검색 SQL의 독립 경계 가드 검증을 위해 관리자 훅을 우회해 의도적으로 stale 후보를 만든다.
      await pool.query(
        `UPDATE guideline_versions SET status = 'SUPERSEDED' WHERE id = $1`,
        [pair.versionA],
      );

      const results = await app
        .get(RetrievalService)
        .searchHybrid('상태경계희소어', undefined, VOCAB_CORPUS_SIZE);
      const keywordIds = results
        .filter((row) => row.keywordRank !== null)
        .map((row) => row.chunk.id);

      expect(keywordIds).toContain(pair.chunkB);
      expect(keywordIds).not.toContain(pair.chunkA);
      expect(results.some((row) => row.version.id === pair.versionA)).toBe(
        false,
      );
    });

    it('기준 13: guidelineIds 필터는 프리필터 후보 집합과 함께 적용된다', async () => {
      const pair = await ingestPairWithTerm('지침필터희소어', 'guideline-filter');
      const selected = await app
        .get(KeywordVocabularyService)
        .selectCandidates('지침필터희소어');
      expect([...(selected.chunkIds ?? [])].sort()).toEqual(
        [pair.chunkA, pair.chunkB].sort(),
      );

      const results = await app
        .get(RetrievalService)
        .searchHybrid(
          '지침필터희소어',
          { guidelineIds: [pair.guidelineA] },
          VOCAB_CORPUS_SIZE,
        );
      const keywordRows = results.filter((row) => row.keywordRank !== null);

      expect(keywordRows.length).toBeGreaterThan(0);
      expect(
        keywordRows.every((row) => row.guideline.id === pair.guidelineA),
      ).toBe(true);
      expect(keywordRows.map((row) => row.chunk.id)).toContain(pair.chunkA);
      expect(keywordRows.map((row) => row.chunk.id)).not.toContain(pair.chunkB);
    });
  });

  describe('C. 코퍼스 변경의 증분 어휘 갱신', () => {
    it('기준 14: 인제스트한 판본 전용 어절의 포스팅이 그 새 청크를 후보로 가리킨다', async () => {
      await ingest(keywordVocabCorpus);
      const vocabulary = app.get(KeywordVocabularyService);
      const before = await vocabulary.selectCandidates('새판본전용어');
      expect(before.tokens).toEqual([
        { token: '새판본전용어', df: 0, common: false },
      ]);
      const created = await ingest(
        singleChunkGuideline('new-ingest-vocab', '새판본전용어 합성근거문장'),
      );
      const [chunkId] = await chunkIdsForVersion(created.guidelineVersionId);
      const selected = await vocabulary.selectCandidates('새판본전용어');

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
        (await vocabulary.selectCandidates('상태이탈전용어')).tokens[0].df,
      ).toBe(1);

      await patchStatus(created.guidelineVersionId, 'SUPERSEDED');

      expect(await vocabTerm('상태이탈전용어')).toBeUndefined();
      expect(
        (await vocabulary.selectCandidates('상태이탈전용어')).tokens[0].df,
      ).toBe(0);
    });

    it('기준 16: updateVersionStatus SUPERSEDED → ACTIVE는 판본 어절을 다시 넣는다', async () => {
      const created = await ingest(
        singleChunkGuideline('status-restore', '상태복귀전용어 합성근거문장'),
      );
      const vocabulary = app.get(KeywordVocabularyService);
      expect(await vocabTerm('상태복귀전용어')).toBeDefined();
      expect(
        (await vocabulary.selectCandidates('상태복귀전용어')).tokens[0].df,
      ).toBe(1);
      await patchStatus(created.guidelineVersionId, 'SUPERSEDED');
      expect(await vocabTerm('상태복귀전용어')).toBeUndefined();
      expect(
        (await vocabulary.selectCandidates('상태복귀전용어')).tokens[0].df,
      ).toBe(0);

      await patchStatus(created.guidelineVersionId, 'ACTIVE');

      expect(await vocabTerm('상태복귀전용어')).toBeDefined();
      expect(
        (await vocabulary.selectCandidates('상태복귀전용어')).tokens[0].df,
      ).toBe(1);
    });

    it('기준 17: deleteVersion은 삭제 판본 전용 어절을 어휘에서 뺀다', async () => {
      const created = await ingest(
        singleChunkGuideline('delete-vocab', '삭제판본전용어 합성근거문장'),
      );
      const vocabulary = app.get(KeywordVocabularyService);
      expect(await vocabTerm('삭제판본전용어')).toBeDefined();
      expect(
        (await vocabulary.selectCandidates('삭제판본전용어')).tokens[0].df,
      ).toBe(1);

      await app
        .get(GuidelineAdminService)
        .deleteVersion(created.guidelineVersionId);

      expect(await vocabTerm('삭제판본전용어')).toBeUndefined();
      expect(
        (await vocabulary.selectCandidates('삭제판본전용어')).tokens[0].df,
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
      );
      expect(before.tokens.map(({ token, df }) => ({ token, df }))).toEqual([
        { token: '공유존재어', df: 2 },
        { token: '첫판본전용어', df: 1 },
      ]);

      await patchStatus(first.guidelineVersionId, 'SUPERSEDED');

      const after = await vocabulary.selectCandidates(
        '공유존재어 첫판본전용어',
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

  describe('D. 롤백 축', () => {
    it('기준 24a: RETRIEVAL_VOCAB_PREFILTER_ENABLED=false면 후보 밖 청크까지 키워드 전량 스캔한다', async () => {
      await ingest(keywordVocabCorpus, disabledApp);
      const rareIds = await pool.query<{ id: string }>(
        `
          SELECT id
          FROM evidence_chunks
          WHERE content ILIKE '%' || $1 || '%'
          ORDER BY id
        `,
        [BOUNDARY_RARE_TERM],
      );
      expect(rareIds.rows).toHaveLength(2);

      const results = await disabledApp
        .get(RetrievalService)
        .searchHybrid(
          `${COMMON_TERM} ${BOUNDARY_RARE_TERM}`,
          undefined,
          VOCAB_CORPUS_SIZE,
        );
      const keywordIds = results
        .filter((row) => row.keywordRank !== null)
        .map((row) => row.chunk.id);
      const rareSet = new Set(rareIds.rows.map((row) => row.id));

      expect(keywordIds).toHaveLength(VOCAB_CORPUS_SIZE);
      expect(keywordIds.some((id) => !rareSet.has(id))).toBe(true);
    });
  });

  describe('E. 정책 버전', () => {
    it('기준 26: 프리필터와 리랭크를 적용한 GenerationRun은 컷을 담은 하드코딩 v5를 기록한다', async () => {
      await ingest(keywordVocabCorpus);
      const selection = await app
        .get(KeywordVocabularyService)
        .selectCandidates(BOUNDARY_RARE_TERM);
      expect(selection.chunkIds).not.toBeNull();
      const before = await generationRunCount(RERANK_POLICY);

      const events = await ask(
        app,
        answerCookie,
        BOUNDARY_RARE_TERM,
        'spec45-v5-rerank',
      );
      const after = await generationRunCount(RERANK_POLICY);

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(after - before).toBe(1);
    });

    it('기준 26b: 프리필터는 켰지만 리랭크가 폴백되면 컷을 담은 no-rerank v5를 기록한다', async () => {
      await ingest(keywordVocabCorpus, fallbackApp);
      const selection = await fallbackApp
        .get(KeywordVocabularyService)
        .selectCandidates(BOUNDARY_RARE_TERM);
      expect(selection.chunkIds).not.toBeNull();
      const before = await generationRunCount(FALLBACK_POLICY);

      const events = await ask(
        fallbackApp,
        fallbackCookie,
        BOUNDARY_RARE_TERM,
        'spec45-v5-fallback',
      );
      const after = await generationRunCount(FALLBACK_POLICY);

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(after - before).toBe(1);
    });

    it('기준 27: 프리필터 플래그가 꺼지면 GenerationRun은 §31의 하드코딩 v4 문자열 그대로다', async () => {
      await ingest(keywordVocabCorpus, disabledApp);
      const before = await generationRunCount(DISABLED_V4_POLICY);

      const events = await ask(
        disabledApp,
        disabledCookie,
        BOUNDARY_RARE_TERM,
        'spec45-disabled-v4',
      );
      const after = await generationRunCount(DISABLED_V4_POLICY);

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(after - before).toBe(1);
    });
  });

  describe('F. 관측', () => {
    it('기준 28: 후보 생성과 순위 1회를 합친 keyword_search 히스토그램 표본만 정확히 1 증가한다', async () => {
      await ingest(keywordVocabCorpus);
      const selection = await app
        .get(KeywordVocabularyService)
        .selectCandidates(BOUNDARY_RARE_TERM);
      expect(selection.chunkIds).not.toBeNull();
      expect(selection.chunkIds).toHaveLength(2);
      const before = await scrapeMetrics(app);
      const beforeStages = metricValuesByLabel(
        before,
        'rag_retrieval_duration_seconds_count',
        'stage',
      );

      await app
        .get(RetrievalService)
        .searchHybrid(
          BOUNDARY_RARE_TERM,
          undefined,
          RERANK_CANDIDATES,
        );
      const after = await scrapeMetrics(app);
      const afterStages = metricValuesByLabel(
        after,
        'rag_retrieval_duration_seconds_count',
        'stage',
      );

      expect(
        metricValue(after, 'rag_retrieval_duration_seconds_count', {
          stage: 'keyword_search',
        }) -
          metricValue(before, 'rag_retrieval_duration_seconds_count', {
            stage: 'keyword_search',
          }),
      ).toBe(1);

      const allStages = new Set([
        ...beforeStages.keys(),
        ...afterStages.keys(),
      ]);
      const changedStages = Object.fromEntries(
        [...allStages]
          .map((stage) => [
            stage,
            (afterStages.get(stage) ?? 0) - (beforeStages.get(stage) ?? 0),
          ] as const)
          .filter(([, delta]) => delta !== 0)
          .sort(([left], [right]) => left.localeCompare(right)),
      );
      expect(changedStages).toEqual({
        embed: 1,
        keyword_search: 1,
        vector_search: 1,
      });
    });
  });
});
