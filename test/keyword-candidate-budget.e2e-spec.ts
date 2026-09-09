// docs/specs/48 수용 기준 9~21·23·26~29 동결 테스트 — 구현 중 수정 금지
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
import { GuidelineIngestInput } from '../src/domain/guideline/service/guideline-ingest.input';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { KeywordVocabularyService } from '../src/domain/guideline/service/keyword-vocabulary.service';
import { retrievalConfig } from '../src/global/config/retrieval.config';
import {
  EMBEDDING_PROVIDER,
  EmbeddingProvider,
} from '../src/infrastructure/embedding/embedding-provider.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import {
  RERANKER,
  RerankCandidate,
  Reranker,
  RerankResult,
} from '../src/infrastructure/retrieval/reranker.port';
import {
  HybridEvidence,
  RetrievalService,
} from '../src/infrastructure/retrieval/retrieval.service';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import {
  BOUNDARY_RARE_TERM,
  keywordVocabCorpus,
} from './fixtures/keyword-vocab-samples';
import { socialSignUp } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const DISTANCE_CUTOFF = 2;
const SCORE_CUTOFF = 6;
const RERANK_CANDIDATES = 5;
const KEYWORD_BUDGET = 2;
const EMBEDDING_MODEL = 'fake-embedding-v1';
const RERANK_POLICY =
  'hybrid-rrf60-top5x2-bm252-rerank-budget-recording-reranker-test' +
  '-cut2-score6-v6/fake-embedding-v1';
const FALLBACK_POLICY =
  'hybrid-rrf60-top5x2-bm252-cut2-v6/fake-embedding-v1';
const DISABLED_V4_POLICY =
  'hybrid-rrf60-top5x2-rerank-budget-disabled-reranker-test-cut2-score6-v4/fake-embedding-v1';

const QUERY_EMBEDDING = [
  1,
  ...Array.from({ length: 1535 }, () => 0),
];

function vectorLiteral(first: number, second: number): string {
  return `[${[
    first,
    second,
    ...Array.from({ length: 1534 }, () => 0),
  ].join(',')}]`;
}

const DIRECT_VECTOR = vectorLiteral(1, 0);

interface TestRetrievalConfig {
  distanceCutoff: number;
  rerankEnabled: boolean;
  rerankCandidates: number;
  rerankScoreCutoff: number;
  hybridEnabled: boolean;
  vocabPrefilterEnabled: boolean;
  keywordCandidateBudget: number;
}

interface DirectChunkFixture {
  id: string;
  content: string;
  embedding?: string;
  embeddingModel?: string;
  recommendationGrade?: string;
  evidenceLevel?: string;
}

interface DirectCorpusOptions {
  guidelineId?: string;
  versionId?: string;
  status?: 'ACTIVE' | 'SUPERSEDED';
}

interface DirectCorpusResult {
  guidelineId: string;
  versionId: string;
  chunkIds: string[];
}

interface SeparatedCorpusResult {
  guidelineIds: string[];
  chunkIds: string[];
  targetGuidelineId: string;
  targetChunkId: string;
}

interface SseEvent {
  eventType: string;
  [key: string]: unknown;
}

interface PrometheusLabels {
  [key: string]: string;
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
  readonly model = 'budget-throwing-reranker-test';
  calls = 0;

  rerank(
    _question: string,
    _candidates: RerankCandidate[],
  ): Promise<RerankResult> {
    this.calls += 1;
    return Promise.reject(new Error('의도된 BM25 예산 리랭커 오류'));
  }
}

const deterministicEmbeddingProvider = {
  model: EMBEDDING_MODEL,
  embed: (texts: string[]): Promise<number[][]> =>
    Promise.resolve(texts.map(() => [...QUERY_EMBEDDING])),
} as unknown as EmbeddingProvider;

function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as SseEvent);
}

function terminalEvent(events: SseEvent[]): SseEvent | undefined {
  return events[events.length - 1];
}

function keywordOrder(rows: HybridEvidence[]): string[] {
  return rows
    .filter((row) => row.keywordRank !== null)
    .sort((left, right) => (left.keywordRank ?? 0) - (right.keywordRank ?? 0))
    .map((row) => row.chunk.id);
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

describe('spec 48: 키워드 arm BM25 후보 예산', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let fallbackApp: INestApplication;
  let disabledApp: INestApplication;
  let adminCookie: string;
  let answerCookie: string;
  let fallbackCookie: string;
  let disabledCookie: string;
  let requestSequence = 0;

  const recordingReranker = new RecordingReranker(
    'budget-recording-reranker-test',
  );
  const throwingReranker = new ThrowingReranker();
  const disabledReranker = new RecordingReranker(
    'budget-disabled-reranker-test',
  );

  const enabledConfig: TestRetrievalConfig = {
    distanceCutoff: DISTANCE_CUTOFF,
    rerankEnabled: true,
    rerankCandidates: RERANK_CANDIDATES,
    rerankScoreCutoff: SCORE_CUTOFF,
    hybridEnabled: true,
    vocabPrefilterEnabled: true,
    keywordCandidateBudget: KEYWORD_BUDGET,
  };

  const createApp = async (
    reranker: Reranker,
    config: TestRetrievalConfig,
  ): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(deterministicEmbeddingProvider)
      .overrideProvider(RERANKER)
      .useValue(reranker)
      .overrideProvider(retrievalConfig.KEY)
      .useValue(config)
      .compile();
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

    const admin = await socialSignUp(app, {
      email: 'spec48-admin@clinic.kr',
      providerId: 'spec48-admin',
      clinicName: '스펙48 관리자 한의원',
      licenseNumber: 'SPEC-4801',
    });
    adminCookie = admin.cookie;
    await pool.query(`UPDATE clinicians SET role = 'ADMIN' WHERE id = $1`, [
      admin.clinicianId,
    ]);
    answerCookie = (
      await socialSignUp(app, {
        email: 'spec48-answer@clinic.kr',
        providerId: 'spec48-answer',
        clinicName: '스펙48 답변 한의원',
        licenseNumber: 'SPEC-4802',
      })
    ).cookie;
    fallbackCookie = (
      await socialSignUp(fallbackApp, {
        email: 'spec48-fallback@clinic.kr',
        providerId: 'spec48-fallback',
        clinicName: '스펙48 폴백 한의원',
        licenseNumber: 'SPEC-4803',
      })
    ).cookie;
    disabledCookie = (
      await socialSignUp(disabledApp, {
        email: 'spec48-disabled@clinic.kr',
        providerId: 'spec48-disabled',
        clinicName: '스펙48 롤백 한의원',
        licenseNumber: 'SPEC-4804',
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
      target.get(KeywordVocabularyService).invalidate();
    }
    jest.clearAllMocks();
  });

  afterAll(async () => {
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

  const insertDirectCorpus = async (
    key: string,
    chunks: DirectChunkFixture[],
    options: DirectCorpusOptions = {},
  ): Promise<DirectCorpusResult> => {
    const guidelineId = options.guidelineId ?? `${key}-guideline`;
    const versionId = options.versionId ?? `${key}-version`;
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
        VALUES ($1, $2, '1.0', 1, $3, $4, $5, $6)
      `,
      [
        versionId,
        guidelineId,
        options.status ?? 'ACTIVE',
        new Date('2026-09-09T00:00:00.000Z'),
        `https://example.test/spec48/${key}`,
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
            embedding_model, recommendation_grade, evidence_level,
            "order", content_hash
          )
          VALUES (
            $1, $2, $3, $4, $5::vector,
            $6, $7::jsonb, $8::jsonb, $9, $10
          )
        `,
        [
          chunk.id,
          sectionId,
          versionId,
          chunk.content,
          chunk.embedding ?? DIRECT_VECTOR,
          chunk.embeddingModel ?? EMBEDDING_MODEL,
          chunk.recommendationGrade
            ? JSON.stringify({
                code: chunk.recommendationGrade,
                label: chunk.recommendationGrade,
              })
            : null,
          chunk.evidenceLevel
            ? JSON.stringify({
                code: chunk.evidenceLevel,
                label: chunk.evidenceLevel,
              })
            : null,
          index,
          createHash('sha256')
            .update(`${key}:${chunk.id}:${chunk.content}`)
            .digest('hex'),
        ],
      );
    }
    return {
      guidelineId,
      versionId,
      chunkIds: chunks.map((chunk) => chunk.id),
    };
  };

  const insertSeparatedMatchingCorpus = async (
    key: string,
    term: string,
  ): Promise<SeparatedCorpusResult> => {
    const first = await insertDirectCorpus(`${key}-first`, [
      { id: `${key}-a`, content: term },
    ]);
    const second = await insertDirectCorpus(`${key}-second`, [
      { id: `${key}-b`, content: term },
    ]);
    const target = await insertDirectCorpus(`${key}-target`, [
      { id: `${key}-z`, content: term },
    ]);
    return {
      guidelineIds: [first.guidelineId, second.guidelineId, target.guidelineId],
      chunkIds: [first.chunkIds[0], second.chunkIds[0], target.chunkIds[0]],
      targetGuidelineId: target.guidelineId,
      targetChunkId: target.chunkIds[0],
    };
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

  describe('A. 후보 0건 금지와 어휘 부재', () => {
    it('기준 9: 모든 질의 토큰의 df가 0이면 null 후보로 접고 키워드 arm은 전량을 순위화한다', async () => {
      const corpus = await insertDirectCorpus('unknown-fallback', [
        { id: 'unknown-a', content: '합성근거 하나' },
        { id: 'unknown-b', content: '합성근거 둘' },
        { id: 'unknown-c', content: '합성근거 셋' },
        { id: 'unknown-d', content: '합성근거 넷' },
      ]);
      const vocabulary = app.get(KeywordVocabularyService);
      await vocabulary.rebuildAll();

      const selected = await vocabulary.selectCandidates('미등재신조어', KEYWORD_BUDGET);
      const results = await app
        .get(RetrievalService)
        .searchHybrid('미등재신조어', undefined, corpus.chunkIds.length);

      expect(selected.tokens).toEqual([
        { token: '미등재신조어', df: 0, common: false },
      ]);
      expect(selected.chunkIds).toBeNull();
      expect(keywordOrder(results).sort()).toEqual([...corpus.chunkIds].sort());
    });

    it('기준 10: keyword_vocab가 비어 있는 배포 창에도 키워드 arm은 결과를 낸다', async () => {
      const corpus = await insertDirectCorpus('empty-vocab', [
        { id: 'empty-a', content: '백필전검색어 첫근거' },
        { id: 'empty-b', content: '백필전검색어 둘근거' },
        { id: 'empty-c', content: '백필전검색어 셋근거' },
      ]);
      const vocabulary = app.get(KeywordVocabularyService);
      const stored = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM keyword_vocab',
      );

      const selected = await vocabulary.selectCandidates('백필전검색어', KEYWORD_BUDGET);
      const results = await app
        .get(RetrievalService)
        .searchHybrid('백필전검색어', undefined, corpus.chunkIds.length);

      expect(stored.rows[0].count).toBe(0);
      expect(selected.chunkIds).toBeNull();
      expect(keywordOrder(results)).toHaveLength(corpus.chunkIds.length);
      expect(keywordOrder(results)).toEqual(expect.arrayContaining(corpus.chunkIds));
    });
  });

  describe('B. 순위와 RRF 융합 불변', () => {
    it('기준 11: BM25는 후보만 고르고 실제 keywordRank는 원문 word_similarity 순서다', async () => {
      await insertDirectCorpus('rank-split', [
        {
          id: 'bm25-z',
          content: '임상적 임상연구 치료법 치료전략',
        },
        { id: 'word-a', content: '임상 치료' },
        { id: 'rank-background-a', content: '배경어휘하나' },
        { id: 'rank-background-b', content: '배경어휘둘' },
      ]);
      const vocabulary = app.get(KeywordVocabularyService);
      await vocabulary.rebuildAll();
      const query = '임상 치료';

      // 명세 BM25 식으로 N=4, avgdl=2, 두 토큰 모두 df=2다.
      // bm25-z: 2 * ln(2) * 4.4/4.1 ≈ 1.488
      // word-a: 2 * ln(2) * 2.2/2.2 ≈ 1.386
      const selected = await vocabulary.selectCandidates(query, KEYWORD_BUDGET);
      const wordSimilarityOrder = await pool.query<{ id: string }>(
        `
          SELECT id
          FROM evidence_chunks
          WHERE id = ANY($1::text[])
          ORDER BY word_similarity($2::text, content) DESC, id ASC
        `,
        [['bm25-z', 'word-a'], query],
      );
      const results = await app
        .get(RetrievalService)
        .searchHybrid(query, undefined, 4);

      expect(selected.chunkIds).toEqual(['bm25-z', 'word-a']);
      expect(wordSimilarityOrder.rows.map((row) => row.id)).toEqual([
        'word-a',
        'bm25-z',
      ]);
      expect(selected.chunkIds).not.toEqual(
        wordSimilarityOrder.rows.map((row) => row.id),
      );
      expect(keywordOrder(results)).toEqual(
        wordSimilarityOrder.rows.map((row) => row.id),
      );
    });

    it('기준 12: word_similarity가 동점이면 keywordRank는 청크 id 오름차순이다', async () => {
      await insertDirectCorpus('keyword-tie', [
        { id: 'tie-z', content: '동점검색어 같은배경' },
        { id: 'tie-a', content: '동점검색어 같은배경' },
      ]);
      const vocabulary = app.get(KeywordVocabularyService);
      await vocabulary.rebuildAll();
      const scores = await pool.query<{ id: string; score: number }>(
        `
          SELECT id, word_similarity($1::text, content)::float8 AS score
          FROM evidence_chunks
          ORDER BY id
        `,
        ['동점검색어'],
      );

      const selected = await vocabulary.selectCandidates('동점검색어', KEYWORD_BUDGET);
      const results = await app
        .get(RetrievalService)
        .searchHybrid('동점검색어', undefined, 2);

      expect(Number(scores.rows[0].score)).toBe(Number(scores.rows[1].score));
      expect(selected.chunkIds).toEqual(['tie-a', 'tie-z']);
      expect(keywordOrder(results)).toEqual(['tie-a', 'tie-z']);
    });

    it('기준 13: RRF 순서와 vectorRank·keywordRank 부기는 §31 규칙 그대로다', async () => {
      await insertDirectCorpus('rrf', [
        {
          id: 'rrf-a',
          content: '융합표식 공통근거',
          embedding: vectorLiteral(0, 1),
        },
        {
          id: 'rrf-b',
          content: '융합표식 공통근거',
          embedding: vectorLiteral(0.8, 0.6),
        },
        {
          id: 'rrf-c',
          content: '비매칭배경',
          embedding: vectorLiteral(1, 0),
        },
      ]);
      const vocabulary = app.get(KeywordVocabularyService);
      await vocabulary.rebuildAll();
      const selected = await vocabulary.selectCandidates('융합표식', KEYWORD_BUDGET);

      const results = await app
        .get(RetrievalService)
        .searchHybrid('융합표식', undefined, 2);

      expect(selected.chunkIds).toEqual(['rrf-a', 'rrf-b']);
      expect(
        results.map((row) => ({
          id: row.chunk.id,
          vectorRank: row.vectorRank,
          keywordRank: row.keywordRank,
        })),
      ).toEqual([
        { id: 'rrf-b', vectorRank: 2, keywordRank: 2 },
        { id: 'rrf-c', vectorRank: 1, keywordRank: null },
        { id: 'rrf-a', vectorRank: null, keywordRank: 1 },
      ]);
    });

    it('기준 14: 후보 스냅샷에 있어도 타 embedding_model과 비ACTIVE 판본은 결과 경계를 못 넘는다', async () => {
      const wrongModel = await insertDirectCorpus('boundary-model', [
        {
          id: 'boundary-a-model',
          content: '경계표식 동일근거',
          embeddingModel: 'other-embedding-model',
        },
      ]);
      const staleStatus = await insertDirectCorpus('boundary-status', [
        { id: 'boundary-b-status', content: '경계표식 동일근거' },
      ]);
      const valid = await insertDirectCorpus('boundary-valid', [
        { id: 'boundary-z-valid', content: '경계표식 동일근거' },
      ]);
      const vocabulary = app.get(KeywordVocabularyService);
      await vocabulary.rebuildAll();
      const before = await vocabulary.selectCandidates('경계표식', 10);
      await pool.query(
        `UPDATE guideline_versions SET status = 'SUPERSEDED' WHERE id = $1`,
        [staleStatus.versionId],
      );
      const staleCandidates = await vocabulary.selectCandidates('경계표식', 10);
      const budgetedCandidates = await vocabulary.selectCandidates(
        '경계표식',
        KEYWORD_BUDGET,
      );

      const results = await app
        .get(RetrievalService)
        .searchHybrid('경계표식', undefined, 3);
      const resultIds = results.map((row) => row.chunk.id);

      expect(before.chunkIds).toEqual([
        wrongModel.chunkIds[0],
        staleStatus.chunkIds[0],
        valid.chunkIds[0],
      ]);
      expect(staleCandidates.chunkIds).toEqual(before.chunkIds);
      expect(budgetedCandidates.chunkIds).toEqual([
        wrongModel.chunkIds[0],
        staleStatus.chunkIds[0],
      ]);
      expect(resultIds).toEqual([valid.chunkIds[0]]);
      expect(resultIds).not.toContain(wrongModel.chunkIds[0]);
      expect(resultIds).not.toContain(staleStatus.chunkIds[0]);
    });
  });

  describe('C. 요청 필터가 있으면 후보 제한만 건너뛴다', () => {
    it('기준 15: guidelineIds가 있으면 예산 밖의 지침 청크도 keywordRank를 받는다', async () => {
      const corpus = await insertSeparatedMatchingCorpus(
        'guideline-filter',
        '지침필터표식',
      );
      const vocabulary = app.get(KeywordVocabularyService);
      await vocabulary.rebuildAll();
      const selected = await vocabulary.selectCandidates('지침필터표식', KEYWORD_BUDGET);

      const results = await app
        .get(RetrievalService)
        .searchHybrid(
          '지침필터표식',
          { guidelineIds: [corpus.targetGuidelineId] },
          3,
        );

      expect(selected.chunkIds).toEqual(corpus.chunkIds.slice(0, 2));
      expect(selected.chunkIds).not.toContain(corpus.targetChunkId);
      expect(keywordOrder(results)).toEqual([corpus.targetChunkId]);
    });

    it('기준 16: recommendationGrades가 있으면 예산 밖의 등급 청크도 keywordRank를 받는다', async () => {
      await insertDirectCorpus('grade-filter', [
        {
          id: 'grade-a',
          content: '등급필터표식',
          recommendationGrade: 'B',
        },
        {
          id: 'grade-b',
          content: '등급필터표식',
          recommendationGrade: 'B',
        },
        {
          id: 'grade-z',
          content: '등급필터표식',
          recommendationGrade: 'A',
        },
      ]);
      const vocabulary = app.get(KeywordVocabularyService);
      await vocabulary.rebuildAll();
      const selected = await vocabulary.selectCandidates('등급필터표식', KEYWORD_BUDGET);

      const results = await app
        .get(RetrievalService)
        .searchHybrid(
          '등급필터표식',
          { recommendationGrades: ['A'] },
          3,
        );

      expect(selected.chunkIds).toEqual(['grade-a', 'grade-b']);
      expect(selected.chunkIds).not.toContain('grade-z');
      expect(keywordOrder(results)).toEqual(['grade-z']);
    });

    it('기준 17: evidenceLevels가 있으면 예산 밖의 근거수준 청크도 keywordRank를 받는다', async () => {
      await insertDirectCorpus('evidence-filter', [
        {
          id: 'evidence-a',
          content: '근거필터표식',
          evidenceLevel: 'Low',
        },
        {
          id: 'evidence-b',
          content: '근거필터표식',
          evidenceLevel: 'Low',
        },
        {
          id: 'evidence-z',
          content: '근거필터표식',
          evidenceLevel: 'Moderate',
        },
      ]);
      const vocabulary = app.get(KeywordVocabularyService);
      await vocabulary.rebuildAll();
      const selected = await vocabulary.selectCandidates('근거필터표식', KEYWORD_BUDGET);

      const results = await app
        .get(RetrievalService)
        .searchHybrid(
          '근거필터표식',
          { evidenceLevels: ['Moderate'] },
          3,
        );

      expect(selected.chunkIds).toEqual(['evidence-a', 'evidence-b']);
      expect(selected.chunkIds).not.toContain('evidence-z');
      expect(keywordOrder(results)).toEqual(['evidence-z']);
    });

    it('기준 18: 같은 질의에서 필터가 모두 없을 때만 예산 2로 잘리고 필터가 있으면 안 잘린다', async () => {
      const corpus = await insertSeparatedMatchingCorpus(
        'filter-contrast',
        '필터대조표식',
      );
      const vocabulary = app.get(KeywordVocabularyService);
      await vocabulary.rebuildAll();

      const withoutFilters = await app
        .get(RetrievalService)
        .searchHybrid('필터대조표식', undefined, 3);
      const withFilters = await app
        .get(RetrievalService)
        .searchHybrid(
          '필터대조표식',
          { guidelineIds: corpus.guidelineIds },
          3,
        );

      expect(keywordOrder(withoutFilters)).toEqual(corpus.chunkIds.slice(0, 2));
      expect(keywordOrder(withoutFilters)).not.toContain(corpus.targetChunkId);
      expect(keywordOrder(withFilters)).toEqual(corpus.chunkIds);
      expect(keywordOrder(withFilters)).toContain(corpus.targetChunkId);
    });

    it('기준 19: 프리필터를 건너뛰어도 요청 필터 자체는 유지되어 범위 밖 청크가 결과에 없다', async () => {
      const corpus = await insertSeparatedMatchingCorpus(
        'filter-boundary',
        '필터경계표식',
      );
      const vocabulary = app.get(KeywordVocabularyService);
      await vocabulary.rebuildAll();
      const selected = await vocabulary.selectCandidates('필터경계표식', KEYWORD_BUDGET);

      const results = await app
        .get(RetrievalService)
        .searchHybrid(
          '필터경계표식',
          { guidelineIds: [corpus.targetGuidelineId] },
          3,
        );
      const resultIds = results.map((row) => row.chunk.id);

      expect(selected.chunkIds).not.toContain(corpus.targetChunkId);
      expect(keywordOrder(results)).toEqual([corpus.targetChunkId]);
      expect(
        results.every((row) => row.guideline.id === corpus.targetGuidelineId),
      ).toBe(true);
      expect(resultIds).not.toContain(corpus.chunkIds[0]);
      expect(resultIds).not.toContain(corpus.chunkIds[1]);
    });

    it('기준 20: 필터가 걸리고 어휘 표가 비어 있어도 필터 범위의 키워드 결과를 낸다', async () => {
      const corpus = await insertSeparatedMatchingCorpus(
        'empty-filter',
        '빈어휘필터표식',
      );
      const vocabulary = app.get(KeywordVocabularyService);
      const stored = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM keyword_vocab',
      );
      const emptySelection = await vocabulary.selectCandidates(
        '빈어휘필터표식',
        KEYWORD_BUDGET,
      );

      const results = await app
        .get(RetrievalService)
        .searchHybrid(
          '빈어휘필터표식',
          { guidelineIds: [corpus.targetGuidelineId] },
          3,
        );

      expect(stored.rows[0].count).toBe(0);
      expect(emptySelection.chunkIds).toBeNull();
      expect(keywordOrder(results)).toEqual([corpus.targetChunkId]);
      expect(
        results.every((row) => row.guideline.id === corpus.targetGuidelineId),
      ).toBe(true);
    });
  });

  describe('D. ACTIVE 경계와 파생 통계', () => {
    it('기준 21a: SUPERSEDED 판본이 ACTIVE로 들어오면 N·dl·avgdl이 함께 늘어난다', async () => {
      const baseline = await insertDirectCorpus('stats-enter-base', [
        { id: 'stats-enter-base-chunk', content: '기준어휘 기준보조' },
      ]);
      const incoming = await insertDirectCorpus(
        'stats-enter-new',
        [
          {
            id: 'stats-enter-new-chunk',
            content: '진입어휘 진입보조 진입세째',
          },
        ],
        { status: 'SUPERSEDED' },
      );
      const vocabulary = app.get(KeywordVocabularyService);
      await vocabulary.rebuildAll();

      const before = await vocabulary.derivedStats();
      await patchStatus(incoming.versionId, 'ACTIVE');
      const after = await vocabulary.derivedStats();

      expect(before).toEqual({
        corpusSize: 1,
        avgDocLen: 2,
        docLenByChunkId: { [baseline.chunkIds[0]]: 2 },
      });
      expect(after).toEqual({
        corpusSize: 2,
        avgDocLen: 2.5,
        docLenByChunkId: {
          [baseline.chunkIds[0]]: 2,
          [incoming.chunkIds[0]]: 3,
        },
      });
    });

    it('기준 21b: ACTIVE 판본이 나가면 N·dl·avgdl도 그 판본 포스팅을 즉시 뺀다', async () => {
      const baseline = await insertDirectCorpus('stats-exit-base', [
        { id: 'stats-exit-base-chunk', content: '기준어휘 기준보조' },
      ]);
      const leaving = await insertDirectCorpus('stats-exit-old', [
        {
          id: 'stats-exit-old-chunk',
          content: '이탈어휘 이탈보조 이탈세째',
        },
      ]);
      const vocabulary = app.get(KeywordVocabularyService);
      await vocabulary.rebuildAll();

      const before = await vocabulary.derivedStats();
      await patchStatus(leaving.versionId, 'SUPERSEDED');
      const after = await vocabulary.derivedStats();

      expect(before).toEqual({
        corpusSize: 2,
        avgDocLen: 2.5,
        docLenByChunkId: {
          [baseline.chunkIds[0]]: 2,
          [leaving.chunkIds[0]]: 3,
        },
      });
      expect(after).toEqual({
        corpusSize: 1,
        avgDocLen: 2,
        docLenByChunkId: { [baseline.chunkIds[0]]: 2 },
      });
    });
  });

  describe('E. 롤백 축', () => {
    it('기준 23: 플래그를 끄면 BM25 예산 밖과 미매칭 청크까지 키워드 arm이 전량 스캔한다', async () => {
      const corpus = await insertDirectCorpus('rollback-scan', [
        { id: 'rollback-a', content: '롤백표식' },
        { id: 'rollback-b', content: '롤백표식' },
        { id: 'rollback-z', content: '롤백표식' },
        { id: 'rollback-outside', content: '미매칭배경' },
      ]);
      const vocabulary = app.get(KeywordVocabularyService);
      await vocabulary.rebuildAll();
      const selected = await vocabulary.selectCandidates('롤백표식', KEYWORD_BUDGET);

      const enabledResults = await app
        .get(RetrievalService)
        .searchHybrid('롤백표식', undefined, corpus.chunkIds.length);
      const disabledResults = await disabledApp
        .get(RetrievalService)
        .searchHybrid('롤백표식', undefined, corpus.chunkIds.length);

      expect(selected.chunkIds).toEqual(['rollback-a', 'rollback-b']);
      expect(keywordOrder(enabledResults)).toEqual(selected.chunkIds);
      expect(keywordOrder(disabledResults)).toHaveLength(corpus.chunkIds.length);
      expect(keywordOrder(disabledResults)).toEqual(
        expect.arrayContaining(corpus.chunkIds),
      );
      expect(keywordOrder(disabledResults)).toContain('rollback-z');
      expect(keywordOrder(disabledResults)).toContain('rollback-outside');
    });
  });

  describe('F. 정책 버전', () => {
    it('기준 26: 프리필터+리랭크 GenerationRun은 예산을 담은 하드코딩 v6를 기록한다', async () => {
      await ingest(keywordVocabCorpus);
      expect(
        app
          .get(RetrievalService)
          .hybridPolicyVersion(recordingReranker.model),
      ).toBe(RERANK_POLICY);
      const before = await generationRunCount(RERANK_POLICY);

      const events = await ask(
        app,
        answerCookie,
        BOUNDARY_RARE_TERM,
        'spec48-v6-rerank',
      );
      const after = await generationRunCount(RERANK_POLICY);

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(after - before).toBe(1);
    });

    it('기준 27: 리랭커 오류로 폴백한 GenerationRun도 예산을 담은 no-rerank v6다', async () => {
      await ingest(keywordVocabCorpus, fallbackApp);
      expect(
        fallbackApp.get(RetrievalService).hybridPolicyVersion(),
      ).toBe(FALLBACK_POLICY);
      const before = await generationRunCount(FALLBACK_POLICY);

      const events = await ask(
        fallbackApp,
        fallbackCookie,
        BOUNDARY_RARE_TERM,
        'spec48-v6-fallback',
      );
      const after = await generationRunCount(FALLBACK_POLICY);

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(after - before).toBe(1);
    });

    it('기준 28: 플래그가 꺼진 GenerationRun은 bm25 표식 없이 §31의 v4 문자열 그대로다', async () => {
      await ingest(keywordVocabCorpus, disabledApp);
      const before = await generationRunCount(DISABLED_V4_POLICY);

      const events = await ask(
        disabledApp,
        disabledCookie,
        BOUNDARY_RARE_TERM,
        'spec48-disabled-v4',
      );
      const after = await generationRunCount(DISABLED_V4_POLICY);

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(after - before).toBe(1);
      expect(
        disabledApp
          .get(RetrievalService)
          .hybridPolicyVersion(disabledReranker.model),
      ).toBe(DISABLED_V4_POLICY);
      expect(DISABLED_V4_POLICY).not.toContain('bm25');
      // v4가 새 v6의 실제 롤백 축인지 함께 고정해 현재 v5 스텁에서도 RED를 보장한다.
      expect(
        app
          .get(RetrievalService)
          .hybridPolicyVersion(recordingReranker.model),
      ).toBe(RERANK_POLICY);
    });
  });

  describe('G. 관측', () => {
    it('기준 29: 후보 생성+순위 검색 1회는 keyword_search 표본만 정확히 1개 만들고 새 stage를 만들지 않는다', async () => {
      await insertDirectCorpus('metrics', [
        { id: 'metrics-a', content: '계측표식' },
        { id: 'metrics-b', content: '계측표식' },
        { id: 'metrics-c', content: '계측표식' },
      ]);
      const vocabulary = app.get(KeywordVocabularyService);
      await vocabulary.rebuildAll();
      const selected = await vocabulary.selectCandidates('계측표식', KEYWORD_BUDGET);
      expect(selected.chunkIds).toHaveLength(KEYWORD_BUDGET);
      const before = await scrapeMetrics(app);
      const beforeStages = metricValuesByLabel(
        before,
        'rag_retrieval_duration_seconds_count',
        'stage',
      );

      await app
        .get(RetrievalService)
        .searchHybrid('계측표식', undefined, 3);
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
