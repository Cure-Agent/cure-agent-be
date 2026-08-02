// docs/specs/31 수용 기준 1~7·9·10 동결 테스트 — 구현 중 수정 금지
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
import { EvaluationModule } from '../src/domain/evaluation/evaluation.module';
import type { EvalSetItem } from '../src/domain/evaluation/evalset.types';
import { renderEvalReport } from '../src/domain/evaluation/rag-eval.report';
import { RagEvalService } from '../src/domain/evaluation/rag-eval.service';
import { GuidelineIngestInput } from '../src/domain/guideline/service/guideline-ingest.input';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { retrievalConfig } from '../src/global/config/retrieval.config';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import {
  RERANKER,
  RerankCandidate,
  Reranker,
  RerankResult,
} from '../src/infrastructure/retrieval/reranker.port';
import {
  RetrievedEvidence,
  RetrievalService,
} from '../src/infrastructure/retrieval/retrieval.service';
import {
  abstainSample,
  answerableSample,
  sectionPathSample,
} from './fixtures/rag-eval/evalset.sample';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import {
  gyeonbitongGuideline,
  yotongGuideline,
} from './fixtures/guideline-samples';
import { socialSignUp } from './fixtures/social-auth';
import { bootstrapApp } from './fixtures/app-bootstrap';

const CSRF = { 'X-CSRF-Protection': '1' };
const QUESTION = '만성 요통 환자에게 침 치료가 효과적인가요?';
const FAILURE_QUESTION = '서로 다른 합성 권고 가운데 임의의 하나를 찾는 질문입니다.';
const LARGE_CUTOFF = 2;
const SMALL_CUTOFF = 0.000001;
const SCORE_CUTOFF = 6;
const NARROW_CANDIDATES = 1;
const DEFAULT_CANDIDATES = 30;
const YOTONG_TITLE = '요통 한의표준임상진료지침';
const GYEONBITONG_TITLE = '견비통 한의표준임상진료지침';
const FAILURE_GUIDELINE_TITLE = '하이브리드 평가 실패표 검증 지침';
const HYBRID_RERANK_POLICY =
  'hybrid-rrf60-top1x2-rerank-hybrid-recording-reranker-test-cut2-score6-v4/fake-embedding-v1';
const HYBRID_FALLBACK_POLICY =
  'hybrid-rrf60-top1x2-cut2-v4/fake-embedding-v1';
const ROLLBACK_V3_POLICY =
  'cosine-top30-rerank-rollback-reranker-test-cut2-score6-v3/fake-embedding-v1';
const ROLLBACK_V4_POLICY =
  'hybrid-rrf60-top30x2-rerank-rollback-reranker-test-cut2-score6-v4/fake-embedding-v1';

interface SseEvent {
  eventType: string;
  [key: string]: unknown;
}

interface PrometheusLabels {
  [key: string]: string;
}

interface TestRetrievalConfig {
  distanceCutoff: number;
  rerankEnabled: boolean;
  rerankCandidates: number;
  rerankScoreCutoff: number;
  hybridEnabled: boolean;
}

interface VectorMetrics {
  recallAt5: number;
  mrrAt5: number;
  recallAt30: number;
}

class RecordingReranker implements Reranker {
  calls = 0;
  readonly candidateBatches: RerankCandidate[][] = [];

  constructor(
    readonly model: string,
    private readonly relevance: number,
  ) {}

  rerank(
    _question: string,
    candidates: RerankCandidate[],
  ): Promise<RerankResult> {
    this.calls += 1;
    this.candidateBatches.push(candidates.map((candidate) => ({ ...candidate })));
    return Promise.resolve({
      order: candidates.map((candidate) => candidate.chunkId),
      top1Relevance: this.relevance,
    });
  }
}

class ThrowingReranker implements Reranker {
  readonly model = 'hybrid-throw-reranker-test';
  calls = 0;

  rerank(
    _question: string,
    _candidates: RerankCandidate[],
  ): Promise<RerankResult> {
    this.calls += 1;
    return Promise.reject(new Error('의도된 하이브리드 리랭커 오류'));
  }
}

/** SSE 응답 본문(data: 프레임)을 이벤트 배열로 파싱한다. */
function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as SseEvent);
}

/** 라벨 순서와 무관하게 Prometheus 표본을 읽고, 미등록 표본은 0으로 본다. */
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

    const hasExpectedLabels = Object.entries(expectedLabels).every(
      ([key, value]) => labels[key] === value,
    );
    if (!hasExpectedLabels) continue;

    const value = Number(sample[2]);
    if (Number.isFinite(value)) return value;
  }

  return 0;
}

function terminalEvent(events: SseEvent[]): SseEvent | undefined {
  return events[events.length - 1];
}

function eventOf(events: SseEvent[], eventType: string): SseEvent {
  const event = events.find((candidate) => candidate.eventType === eventType);
  if (!event) throw new Error(eventType + ' 이벤트가 없습니다.');
  return event;
}

/** EvidenceDetail의 안정 필드인 evidence_chunks.id만 꺼낸다. */
function evidenceIds(event: SseEvent): string[] {
  if (!Array.isArray(event.evidence)) {
    throw new Error('retrieval.completed evidence가 배열이 아닙니다.');
  }

  return event.evidence.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error('evidence 항목이 객체가 아닙니다.');
    }
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string') {
      throw new Error('evidence 항목에 문자열 id가 없습니다.');
    }
    return id;
  });
}

/** 지정한 라벨 조각이 모두 있는 행의 마지막 숫자를 비율 값으로 읽는다. */
function renderedMetricValues(
  markdown: string,
  labelPatterns: RegExp[],
): number[] {
  const values: number[] = [];

  for (const line of markdown.split('\n')) {
    if (!labelPatterns.every((pattern) => pattern.test(line))) continue;
    const matches = [
      ...line.matchAll(/(?<![@a-zA-Z0-9_])(-?\d+(?:\.\d+)?)\s*(%?)/g),
    ];
    if (matches.length === 0) continue;

    const match = matches[matches.length - 1];
    const value = Number(match[1]);
    values.push(match[2] === '%' ? value / 100 : value);
  }

  return values;
}

function samePath(actual: unknown, expected: string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((part, index) => part === expected[index])
  );
}

function matchesExpectedEvidence(
  row: RetrievedEvidence,
  item: EvalSetItem,
): boolean {
  return item.expectedEvidence.some((expected) => {
    const locator = expected as {
      guidelineTitle: string;
      publisher: string;
      recommendationNumber?: string;
      sectionPath?: string[];
    };
    if (
      row.guideline.title !== locator.guidelineTitle ||
      row.guideline.publisher !== locator.publisher
    ) {
      return false;
    }

    if (locator.recommendationNumber !== undefined) {
      return row.chunk.recommendationNumber === locator.recommendationNumber;
    }

    if (locator.sectionPath !== undefined) {
      const sectionPath = (row.section as unknown as { path?: unknown }).path;
      return samePath(sectionPath, locator.sectionPath);
    }

    return false;
  });
}

async function calculateVectorMetrics(
  retrieval: RetrievalService,
  items: EvalSetItem[],
): Promise<VectorMetrics> {
  const answerable = items.filter((item) => item.kind === 'answerable');
  const ranks = await Promise.all(
    answerable.map(async (item) => {
      const rows = await retrieval.search(item.question, undefined, 30);
      const index = rows.findIndex((row) => matchesExpectedEvidence(row, item));
      return index === -1 ? null : index + 1;
    }),
  );

  const denominator = answerable.length;
  return {
    recallAt5:
      ranks.filter((rank) => rank !== null && rank <= 5).length / denominator,
    mrrAt5:
      ranks.reduce<number>(
        (sum, rank) => sum + (rank !== null && rank <= 5 ? 1 / rank : 0),
        0,
      ) / denominator,
    recallAt30:
      ranks.filter((rank) => rank !== null && rank <= 30).length / denominator,
  };
}

const evaluationFailureGuideline: GuidelineIngestInput = {
  title: FAILURE_GUIDELINE_TITLE,
  publisher: '동결 테스트 발행처',
  version: '1.0',
  publishedAt: '2026-08-02',
  sourceUrl: 'https://example.test/hybrid-eval-failure',
  sections: [
    {
      path: ['1', '합성 권고'],
      title: '합성 권고',
      order: 1,
      chunks: Array.from({ length: 36 }, (_, index) => ({
        content:
          '평가 실패표 필드 검증을 위한 서로 다른 합성 임상 문장 ' +
          String(index + 1) +
          '번이다.',
        recommendationNumber: 'F' + String(index + 1).padStart(2, '0'),
      })),
    },
  ],
};

const evaluationItems: EvalSetItem[] = [
  answerableSample,
  sectionPathSample,
  abstainSample,
];

describe('spec 31: pg_trgm 키워드 arm과 RRF 합집합 하이브리드 검색', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let hybridApp: INestApplication;
  let gateApp: INestApplication;
  let throwApp: INestApplication;
  let rollbackApp: INestApplication;
  let evaluationApp: INestApplication;
  let hybridCookie: string;
  let gateCookie: string;
  let throwCookie: string;
  let rollbackCookie: string;
  let yotongGuidelineId: string;
  let yotongVersionId: string;
  let yotongR1ChunkId: string;
  let gyeonbitongGuidelineId: string;
  let gyeonbitongVersionId: string;
  let failureVersionId: string;
  let requestSequence = 0;

  const hybridReranker = new RecordingReranker(
    'hybrid-recording-reranker-test',
    10,
  );
  const gateReranker = new RecordingReranker('hybrid-gate-reranker-test', 10);
  const throwReranker = new ThrowingReranker();
  const rollbackReranker = new RecordingReranker(
    'rollback-reranker-test',
    10,
  );
  const evaluationReranker = new RecordingReranker(
    'hybrid-evaluation-reranker-test',
    10,
  );

  const narrowHybridConfig: TestRetrievalConfig = {
    distanceCutoff: LARGE_CUTOFF,
    rerankEnabled: true,
    rerankCandidates: NARROW_CANDIDATES,
    rerankScoreCutoff: SCORE_CUTOFF,
    hybridEnabled: true,
  };

  const createApp = async (
    reranker: Reranker,
    config: TestRetrievalConfig,
  ): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, EvaluationModule],
    })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(RERANKER)
      .useValue(reranker)
      .overrideProvider(retrievalConfig.KEY)
      .useValue(config)
      .compile();

    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);
    return app;
  };

  const versionStatus = async (versionId: string): Promise<string> => {
    const result = await pool.query<{ status: string }>(
      'SELECT status::text AS status FROM guideline_versions WHERE id = $1',
      [versionId],
    );
    if (!result.rows[0]) throw new Error('지침 판본 상태를 찾지 못했습니다.');
    return result.rows[0].status;
  };

  const setVersionStatus = async (
    versionId: string,
    status: string,
  ): Promise<void> => {
    await pool.query('UPDATE guideline_versions SET status = $1 WHERE id = $2', [
      status,
      versionId,
    ]);
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

    hybridApp = await createApp(hybridReranker, narrowHybridConfig);
    gateApp = await createApp(gateReranker, {
      ...narrowHybridConfig,
      distanceCutoff: SMALL_CUTOFF,
    });
    throwApp = await createApp(throwReranker, narrowHybridConfig);
    rollbackApp = await createApp(rollbackReranker, {
      ...narrowHybridConfig,
      rerankCandidates: DEFAULT_CANDIDATES,
      hybridEnabled: false,
    });
    evaluationApp = await createApp(evaluationReranker, {
      ...narrowHybridConfig,
      rerankCandidates: DEFAULT_CANDIDATES,
    });

    const ingest = hybridApp.get(GuidelineIngestService);
    await ingest.ingest(yotongGuideline);
    const yotongRows = await hybridApp
      .get(RetrievalService)
      .search(QUESTION, undefined, 100);
    const yotongR1 = yotongRows.find(
      (row) =>
        row.guideline.title === YOTONG_TITLE &&
        row.chunk.recommendationNumber === 'R1',
    );

    await ingest.ingest(gyeonbitongGuideline);
    const rowsWithGyeonbitong = await hybridApp
      .get(RetrievalService)
      .search(QUESTION, undefined, 100);
    const gyeonbitong = rowsWithGyeonbitong.find(
      (row) => row.guideline.title === GYEONBITONG_TITLE,
    );

    if (!yotongR1 || !gyeonbitong) {
      throw new Error('하이브리드 동결 테스트 코퍼스를 찾지 못했습니다.');
    }

    yotongGuidelineId = yotongR1.guideline.id;
    yotongVersionId = yotongR1.version.id;
    yotongR1ChunkId = yotongR1.chunk.id;
    gyeonbitongGuidelineId = gyeonbitong.guideline.id;
    gyeonbitongVersionId = gyeonbitong.version.id;
    await setVersionStatus(gyeonbitongVersionId, 'SUPERSEDED');

    await ingest.ingest(evaluationFailureGuideline);
    const rowsWithFailureFixture = await hybridApp
      .get(RetrievalService)
      .search(FAILURE_QUESTION, undefined, 100);
    const failureRow = rowsWithFailureFixture.find(
      (row) => row.guideline.title === FAILURE_GUIDELINE_TITLE,
    );
    if (!failureRow) {
      throw new Error('평가 실패표 검증 코퍼스를 찾지 못했습니다.');
    }
    failureVersionId = failureRow.version.id;

    // 기본 코퍼스는 명세에 실측된 요통 3청크만 ACTIVE로 둔다.
    await setVersionStatus(failureVersionId, 'SUPERSEDED');

    hybridCookie = (
      await socialSignUp(hybridApp, {
        email: 'hybrid-main@clinic.kr',
        clinicName: '하이브리드검색한의원',
        licenseNumber: 'LIC-3101',
      })
    ).cookie;
    gateCookie = (
      await socialSignUp(gateApp, {
        email: 'hybrid-gate@clinic.kr',
        clinicName: '하이브리드게이트한의원',
        licenseNumber: 'LIC-3102',
      })
    ).cookie;
    throwCookie = (
      await socialSignUp(throwApp, {
        email: 'hybrid-fallback@clinic.kr',
        clinicName: '하이브리드폴백한의원',
        licenseNumber: 'LIC-3103',
      })
    ).cookie;
    rollbackCookie = (
      await socialSignUp(rollbackApp, {
        email: 'hybrid-rollback@clinic.kr',
        clinicName: '하이브리드롤백한의원',
        licenseNumber: 'LIC-3104',
      })
    ).cookie;
  });

  afterAll(async () => {
    await evaluationApp?.close();
    await rollbackApp?.close();
    await throwApp?.close();
    await gateApp?.close();
    await hybridApp?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  const scrapeMetrics = async (app: INestApplication): Promise<string> => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/metrics')
      .expect(200);
    return response.text;
  };

  const createConversation = async (
    app: INestApplication,
    cookie: string,
  ): Promise<string> => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ type: 'GUIDELINE_QA' })
      .expect(201);
    return created.body.data.id as string;
  };

  const ask = async (
    app: INestApplication,
    cookie: string,
    conversationId: string,
    prefix: string,
  ): Promise<SseEvent[]> => {
    requestSequence += 1;
    const response = await request(app.getHttpServer())
      .post(
        '/api/v1/conversations/' + conversationId + '/messages/stream',
      )
      .set(CSRF)
      .set('Cookie', cookie)
      .send({
        content: QUESTION,
        clientRequestId: prefix + '-' + String(requestSequence),
      })
      .expect(200);
    return parseSse(response.text);
  };

  const askInNewConversation = async (
    app: INestApplication,
    cookie: string,
    prefix: string,
  ): Promise<SseEvent[]> => {
    const conversationId = await createConversation(app, cookie);
    return ask(app, cookie, conversationId, prefix);
  };

  const generationRunCount = async (policyVersion: string): Promise<number> => {
    const result = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM generation_runs WHERE retrieval_policy_version = $1',
      [policyVersion],
    );
    return Number(result.rows[0].count);
  };

  describe('기준 1: 합집합 후보 확장과 리랭커 전달', () => {
    it('기준 1a: armK=1 하이브리드 결과는 벡터 arm 결과를 모두 포함한다', async () => {
      const retrieval = hybridApp.get(RetrievalService);
      const vector = await retrieval.search(QUESTION, undefined, 1);
      const hybrid = await retrieval.searchHybrid(QUESTION, undefined, 1);

      expect(vector.length).toBeGreaterThan(0);
      expect(hybrid.map((row) => row.chunk.id)).toEqual(
        expect.arrayContaining(vector.map((row) => row.chunk.id)),
      );
    });

    it('기준 1b: armK=1 결과에 벡터 arm에는 없고 키워드 arm에만 든 청크가 있다', async () => {
      const hybrid = await hybridApp
        .get(RetrievalService)
        .searchHybrid(QUESTION, undefined, 1);
      const keywordOnly = hybrid.find(
        (row) => row.vectorRank === null && typeof row.keywordRank === 'number',
      );

      expect(keywordOnly).toBeDefined();
    });

    it('기준 1c: 키워드 전용 청크가 대화 스트림의 리랭커 후보로 전달된다', async () => {
      const hybrid = await hybridApp
        .get(RetrievalService)
        .searchHybrid(QUESTION, undefined, 1);
      const keywordOnly = hybrid.find(
        (row) => row.vectorRank === null && typeof row.keywordRank === 'number',
      );
      expect(keywordOnly).toBeDefined();

      const batchesBefore = hybridReranker.candidateBatches.length;
      const events = await askInNewConversation(
        hybridApp,
        hybridCookie,
        'req-hybrid-keyword-candidate',
      );
      const batchesAfter = hybridReranker.candidateBatches.length;
      const received = hybridReranker.candidateBatches[batchesAfter - 1] ?? [];

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(batchesAfter - batchesBefore).toBe(1);
      expect(received.map((candidate) => candidate.chunkId)).toContain(
        keywordOnly?.chunk.id,
      );
    });
  });

  describe('기준 2: arm별 1-based 순위 부기', () => {
    it('기준 2a: 두 arm 모두에 든 청크는 vectorRank와 keywordRank가 모두 숫자다', async () => {
      const hybrid = await hybridApp
        .get(RetrievalService)
        .searchHybrid(QUESTION, undefined, 2);
      const bothArms = hybrid.find(
        (row) =>
          typeof row.vectorRank === 'number' &&
          typeof row.keywordRank === 'number',
      );

      expect(bothArms).toBeDefined();
      expect(bothArms?.vectorRank).toBeGreaterThanOrEqual(1);
      expect(bothArms?.keywordRank).toBeGreaterThanOrEqual(1);
    });

    it('기준 2b: 한 arm에만 든 청크는 다른 arm 순위가 정확히 null이다', async () => {
      const hybrid = await hybridApp
        .get(RetrievalService)
        .searchHybrid(QUESTION, undefined, 1);
      const vectorOnly = hybrid.find(
        (row) => typeof row.vectorRank === 'number' && row.keywordRank === null,
      );
      const keywordOnly = hybrid.find(
        (row) => row.vectorRank === null && typeof row.keywordRank === 'number',
      );

      expect(vectorOnly).toMatchObject({ keywordRank: null });
      expect(keywordOnly).toMatchObject({ vectorRank: null });
    });
  });

  describe('기준 3: 후보 최소 거리 게이트 보존', () => {
    it('기준 3a: 극소 거리 컷에서는 키워드 일치 후보가 있어도 기권한다', async () => {
      const candidates = await gateApp
        .get(RetrievalService)
        .searchHybrid(QUESTION, undefined, 1);
      expect(
        candidates.some((row) => typeof row.keywordRank === 'number'),
      ).toBe(true);

      const events = await askInNewConversation(
        gateApp,
        gateCookie,
        'req-hybrid-distance-abstain',
      );

      expect(terminalEvent(events)?.eventType).toBe('answer.abstained');
    });

    it('기준 3b: 거리 기권이면 리랭커 호출 수가 증가하지 않는다', async () => {
      const candidates = await gateApp
        .get(RetrievalService)
        .searchHybrid(QUESTION, undefined, 1);
      expect(
        candidates.some((row) => typeof row.keywordRank === 'number'),
      ).toBe(true);
      const callsBefore = gateReranker.calls;

      await askInNewConversation(
        gateApp,
        gateCookie,
        'req-hybrid-distance-no-rerank',
      );

      expect(gateReranker.calls - callsBefore).toBe(0);
    });
  });

  describe('기준 4: 두 arm의 동일 코퍼스 경계', () => {
    it('기준 4a: embedding_model이 다른 청크는 하이브리드 후보에서 제외한다', async () => {
      const retrieval = hybridApp.get(RetrievalService);
      const control = await retrieval.searchHybrid(QUESTION, undefined, 3);
      expect(control.map((row) => row.chunk.id)).toContain(yotongR1ChunkId);

      const original = await pool.query<{ embedding_model: string }>(
        'SELECT embedding_model FROM evidence_chunks WHERE id = $1',
        [yotongR1ChunkId],
      );
      if (!original.rows[0]) throw new Error('검증할 청크를 찾지 못했습니다.');

      await pool.query(
        'UPDATE evidence_chunks SET embedding_model = $1 WHERE id = $2',
        ['other-embedding-model', yotongR1ChunkId],
      );
      try {
        const results = await retrieval.searchHybrid(QUESTION, undefined, 3);
        expect(results.length).toBeGreaterThan(0);
        expect(results.map((row) => row.chunk.id)).not.toContain(
          yotongR1ChunkId,
        );
      } finally {
        await pool.query(
          'UPDATE evidence_chunks SET embedding_model = $1 WHERE id = $2',
          [original.rows[0].embedding_model, yotongR1ChunkId],
        );
      }
    });

    it('기준 4b: ACTIVE가 아닌 판본의 청크는 하이브리드 후보에서 제외한다', async () => {
      const retrieval = hybridApp.get(RetrievalService);
      const control = await retrieval.searchHybrid(QUESTION, undefined, 3);
      expect(control.some((row) => row.version.id === yotongVersionId)).toBe(
        true,
      );

      const originalYotongStatus = await versionStatus(yotongVersionId);
      const originalGyeonbitongStatus = await versionStatus(
        gyeonbitongVersionId,
      );
      await setVersionStatus(gyeonbitongVersionId, 'ACTIVE');
      await setVersionStatus(yotongVersionId, 'SUPERSEDED');
      try {
        const results = await retrieval.searchHybrid(QUESTION, undefined, 10);
        expect(results.length).toBeGreaterThan(0);
        expect(
          results.some((row) => row.version.id === gyeonbitongVersionId),
        ).toBe(true);
        expect(results.some((row) => row.version.id === yotongVersionId)).toBe(
          false,
        );
      } finally {
        await setVersionStatus(yotongVersionId, originalYotongStatus);
        await setVersionStatus(
          gyeonbitongVersionId,
          originalGyeonbitongStatus,
        );
      }
    });
  });

  describe('기준 5: guidelineIds 요청 필터', () => {
    it('기준 5a: 지침 A 필터를 주면 모든 하이브리드 결과가 지침 A 소속이다', async () => {
      const originalStatus = await versionStatus(gyeonbitongVersionId);
      await setVersionStatus(gyeonbitongVersionId, 'ACTIVE');
      try {
        const results = await hybridApp
          .get(RetrievalService)
          .searchHybrid(
            QUESTION,
            { guidelineIds: [yotongGuidelineId] },
            10,
          );

        expect(results.length).toBeGreaterThan(0);
        expect(
          results.every((row) => row.guideline.id === yotongGuidelineId),
        ).toBe(true);
      } finally {
        await setVersionStatus(gyeonbitongVersionId, originalStatus);
      }
    });

    it('기준 5b: 자구가 겹치는 필터 밖 지침 B 청크도 결과에 들어오지 않는다', async () => {
      const originalStatus = await versionStatus(gyeonbitongVersionId);
      await setVersionStatus(gyeonbitongVersionId, 'ACTIVE');
      try {
        const retrieval = hybridApp.get(RetrievalService);
        const unfiltered = await retrieval.searchHybrid(
          QUESTION,
          undefined,
          10,
        );
        const outsideMatch = unfiltered.find(
          (row) => row.guideline.id === gyeonbitongGuidelineId,
        );
        expect(outsideMatch).toBeDefined();
        expect(typeof outsideMatch?.keywordRank).toBe('number');

        const filtered = await retrieval.searchHybrid(
          QUESTION,
          { guidelineIds: [yotongGuidelineId] },
          10,
        );
        expect(filtered.length).toBeGreaterThan(0);
        expect(
          filtered.some((row) => row.guideline.id === gyeonbitongGuidelineId),
        ).toBe(false);
      } finally {
        await setVersionStatus(gyeonbitongVersionId, originalStatus);
      }
    });
  });

  describe('기준 6: v4 정책 문자열과 RRF 폴백', () => {
    it('기준 6a: 리랭크 성공 GenerationRun은 하드코딩한 v4 rerank 정책을 기록한다', async () => {
      const hybridProbe = await hybridApp
        .get(RetrievalService)
        .searchHybrid(QUESTION, undefined, NARROW_CANDIDATES);
      expect(hybridProbe.length).toBeGreaterThan(0);
      const before = await generationRunCount(HYBRID_RERANK_POLICY);

      const events = await askInNewConversation(
        hybridApp,
        hybridCookie,
        'req-hybrid-v4-rerank-policy',
      );
      const after = await generationRunCount(HYBRID_RERANK_POLICY);

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(after - before).toBe(1);
    });

    it('기준 6b: 리랭커 예외 시 RRF 순위 top-5 근거로 정상 완료한다', async () => {
      const rrfOrder = (
        await throwApp
          .get(RetrievalService)
          .searchHybrid(QUESTION, undefined, NARROW_CANDIDATES)
      )
        .slice(0, 5)
        .map((row) => row.chunk.id);
      expect(rrfOrder.length).toBeGreaterThan(0);
      const callsBefore = throwReranker.calls;

      const events = await askInNewConversation(
        throwApp,
        throwCookie,
        'req-hybrid-rrf-fallback',
      );

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(evidenceIds(eventOf(events, 'retrieval.completed'))).toEqual(
        rrfOrder,
      );
      expect(throwReranker.calls - callsBefore).toBe(1);
    });

    it('기준 6c: 리랭커 예외 폴백은 하드코딩한 v4 no-rerank 정책을 기록한다', async () => {
      const hybridProbe = await throwApp
        .get(RetrievalService)
        .searchHybrid(QUESTION, undefined, NARROW_CANDIDATES);
      expect(hybridProbe.length).toBeGreaterThan(0);
      const before = await generationRunCount(HYBRID_FALLBACK_POLICY);

      const events = await askInNewConversation(
        throwApp,
        throwCookie,
        'req-hybrid-v4-fallback-policy',
      );
      const after = await generationRunCount(HYBRID_FALLBACK_POLICY);

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(after - before).toBe(1);
    });

    it('기준 6d: 리랭커 예외 폴백은 fallback 카운터를 정확히 1 올린다', async () => {
      const hybridProbe = await throwApp
        .get(RetrievalService)
        .searchHybrid(QUESTION, undefined, NARROW_CANDIDATES);
      expect(hybridProbe.length).toBeGreaterThan(0);
      const conversationId = await createConversation(throwApp, throwCookie);
      const before = await scrapeMetrics(throwApp);

      await ask(
        throwApp,
        throwCookie,
        conversationId,
        'req-hybrid-fallback-metric',
      );
      const after = await scrapeMetrics(throwApp);

      expect(
        metricValue(after, 'rag_rerank_total', { outcome: 'fallback' }) -
          metricValue(before, 'rag_rerank_total', { outcome: 'fallback' }),
      ).toBe(1);
    });
  });

  describe('기준 7: hybridEnabled 롤백 축', () => {
    it('기준 7a: hybridEnabled=false 스트림 근거는 벡터 top-5와 동일하다', async () => {
      const hybridProbe = await hybridApp
        .get(RetrievalService)
        .searchHybrid(QUESTION, undefined, 1);
      expect(hybridProbe.length).toBeGreaterThan(0);

      const retrieval = rollbackApp.get(RetrievalService);
      const vectorTop5 = (await retrieval.search(QUESTION, undefined, 5)).map(
        (row) => row.chunk.id,
      );
      const events = await askInNewConversation(
        rollbackApp,
        rollbackCookie,
        'req-hybrid-disabled-order',
      );

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(evidenceIds(eventOf(events, 'retrieval.completed'))).toEqual(
        vectorTop5,
      );
    });

    it('기준 7b: hybridEnabled=false 리랭크 답변은 v4가 아닌 §29 v3 정책을 기록한다', async () => {
      const hybridProbe = await hybridApp
        .get(RetrievalService)
        .searchHybrid(QUESTION, undefined, 1);
      expect(hybridProbe.length).toBeGreaterThan(0);

      const v3Before = await generationRunCount(ROLLBACK_V3_POLICY);
      const v4Before = await generationRunCount(ROLLBACK_V4_POLICY);
      const events = await askInNewConversation(
        rollbackApp,
        rollbackCookie,
        'req-hybrid-disabled-v3-policy',
      );
      const v3After = await generationRunCount(ROLLBACK_V3_POLICY);
      const v4After = await generationRunCount(ROLLBACK_V4_POLICY);

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(v3After - v3Before).toBe(1);
      expect(v4After - v4Before).toBe(0);
    });
  });

  describe('기준 9: 키워드 검색 지연 관측', () => {
    it('기준 9a: 하이브리드 검색 1회가 keyword_search 히스토그램 표본을 1 올린다', async () => {
      const control = await hybridApp
        .get(RetrievalService)
        .searchHybrid(QUESTION, undefined, NARROW_CANDIDATES);
      expect(control.length).toBeGreaterThan(0);
      const before = await scrapeMetrics(hybridApp);

      await hybridApp
        .get(RetrievalService)
        .searchHybrid(QUESTION, undefined, NARROW_CANDIDATES);
      const after = await scrapeMetrics(hybridApp);

      expect(
        metricValue(after, 'rag_retrieval_duration_seconds_count', {
          stage: 'keyword_search',
        }) -
          metricValue(before, 'rag_retrieval_duration_seconds_count', {
            stage: 'keyword_search',
          }),
      ).toBe(1);
    });
  });

  describe('기준 10: eval-rag 하이브리드 지표', () => {
    it('기준 10a: keywordRecallAtK는 유한하며 자구 일치 표본에서 0보다 크다', async () => {
      const report = await evaluationApp
        .get(RagEvalService)
        .evaluate(evaluationItems);

      expect(Number.isFinite(report.keywordRecallAtK)).toBe(true);
      expect(report.keywordRecallAtK).toBeGreaterThan(0);
    });

    it('기준 10b: unionCoverage는 유한하고 벡터 recallAt30 이상의 양수다', async () => {
      const report = await evaluationApp
        .get(RagEvalService)
        .evaluate(evaluationItems);

      expect(Number.isFinite(report.unionCoverage)).toBe(true);
      expect(report.unionCoverage).toBeGreaterThan(0);
      expect(report.unionCoverage).toBeGreaterThanOrEqual(report.recallAt30);
    });

    it('기준 10c: 실패 문항에는 keywordFoundAtRank가 숫자 또는 null로 존재한다', async () => {
      const hybridProbe = await evaluationApp
        .get(RetrievalService)
        .searchHybrid(QUESTION, undefined, DEFAULT_CANDIDATES);
      expect(hybridProbe.length).toBeGreaterThan(0);

      const originalStatus = await versionStatus(failureVersionId);
      await setVersionStatus(failureVersionId, 'ACTIVE');
      try {
        const retrieval = evaluationApp.get(RetrievalService);
        const ranked = await retrieval.search(FAILURE_QUESTION, undefined, 100);
        let targetIndex = -1;
        for (let index = ranked.length - 1; index >= 0; index -= 1) {
          if (ranked[index].guideline.title === FAILURE_GUIDELINE_TITLE) {
            targetIndex = index;
            break;
          }
        }
        expect(targetIndex).toBeGreaterThanOrEqual(30);
        const target = ranked[targetIndex];
        if (!target?.chunk.recommendationNumber) {
          throw new Error('실패 문항의 기대 권고를 만들 수 없습니다.');
        }

        const failureItem: EvalSetItem = {
          id: 'eval-hybrid-keyword-rank-failure',
          kind: 'answerable',
          question: FAILURE_QUESTION,
          expectedEvidence: [
            {
              guidelineTitle: target.guideline.title,
              publisher: target.guideline.publisher,
              recommendationNumber: target.chunk.recommendationNumber,
            },
          ],
          status: 'approved',
          origin: 'manual',
        };
        const report = await evaluationApp
          .get(RagEvalService)
          .evaluate([failureItem]);
        const failure = report.failures.find(
          (item) => item.itemId === failureItem.id,
        );
        expect(failure).toBeDefined();

        const failureRecord = failure as unknown as Record<string, unknown>;
        expect(
          Object.prototype.hasOwnProperty.call(
            failureRecord,
            'keywordFoundAtRank',
          ),
        ).toBe(true);
        const keywordRank = failureRecord.keywordFoundAtRank;
        expect(
          keywordRank === null ||
            (typeof keywordRank === 'number' &&
              Number.isFinite(keywordRank) &&
              keywordRank >= 1),
        ).toBe(true);
      } finally {
        await setVersionStatus(failureVersionId, originalStatus);
      }
    });

    it('기준 10d: 마크다운에 키워드 Recall과 합집합 커버리지 숫자 값이 실린다', async () => {
      const report = await evaluationApp
        .get(RagEvalService)
        .evaluate(evaluationItems);
      expect(report.keywordRecallAtK).toBeGreaterThan(0);
      expect(report.unionCoverage).toBeGreaterThan(0);

      const markdown = renderEvalReport(report);
      const keywordValues = renderedMetricValues(markdown, [
        /키워드|keyword/i,
        /recall/i,
      ]);
      const unionValues = renderedMetricValues(markdown, [
        /합집합|union/i,
        /커버리지|coverage/i,
      ]);

      expect(
        keywordValues.some(
          (value) => Math.abs(value - report.keywordRecallAtK) < 0.005,
        ),
      ).toBe(true);
      expect(
        unionValues.some(
          (value) => Math.abs(value - report.unionCoverage) < 0.005,
        ),
      ).toBe(true);
    });

    it('기준 10e: 벡터 원 지표는 같은 문항의 search() 직접 순위와 일치한다', async () => {
      const retrieval = evaluationApp.get(RetrievalService);
      const hybridProbe = await retrieval.searchHybrid(
        answerableSample.question,
        undefined,
        DEFAULT_CANDIDATES,
      );
      expect(hybridProbe.length).toBeGreaterThan(0);

      const expected = await calculateVectorMetrics(retrieval, evaluationItems);
      const report = await evaluationApp
        .get(RagEvalService)
        .evaluate(evaluationItems);

      expect(report.recallAt5).toBeCloseTo(expected.recallAt5, 10);
      expect(report.mrrAt5).toBeCloseTo(expected.mrrAt5, 10);
      expect(report.recallAt30).toBeCloseTo(expected.recallAt30, 10);
    });
  });
});
