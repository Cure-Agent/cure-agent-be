// docs/specs/29 수용 기준 1~8·10 동결 테스트 — 구현 중 수정 금지
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
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { retrievalConfig } from '../src/global/config/retrieval.config';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import {
  RERANKER,
  RerankCandidate,
  Reranker,
  RerankResult,
} from '../src/infrastructure/retrieval/reranker.port';
import { RetrievalService } from '../src/infrastructure/retrieval/retrieval.service';
import {
  abstainSample,
  answerableSample,
  sectionPathSample,
} from './fixtures/rag-eval/evalset.sample';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { yotongGuideline } from './fixtures/guideline-samples';
import { socialSignUp } from './fixtures/social-auth';
import { bootstrapApp } from './fixtures/app-bootstrap';

const CSRF = { 'X-CSRF-Protection': '1' };
const QUESTION = '만성 요통 환자에게 침 치료가 효과적인가요?';
const LARGE_CUTOFF = 2;
const SMALL_CUTOFF = 0.000001;
const SCORE_CUTOFF = 6;
const RERANK_CANDIDATES = 30;
const V2_POLICY_VERSION = 'cosine-top5-cut2-v2/fake-embedding-v1';
const REVERSED_V3_POLICY_VERSION =
  'cosine-top30-rerank-reverse-reranker-test-cut2-score6-v3/fake-embedding-v1';

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
}

class ReversingReranker implements Reranker {
  readonly model = 'reverse-reranker-test';
  calls = 0;

  rerank(
    _question: string,
    candidates: RerankCandidate[],
  ): Promise<RerankResult> {
    this.calls += 1;
    return Promise.resolve({
      order: candidates.map((candidate) => candidate.chunkId).reverse(),
      top1Relevance: 10,
    });
  }
}

class KeepingReranker implements Reranker {
  calls = 0;

  constructor(
    readonly model: string,
    private readonly relevance: number,
  ) {}

  rerank(
    _question: string,
    candidates: RerankCandidate[],
  ): Promise<RerankResult> {
    this.calls += 1;
    return Promise.resolve({
      order: candidates.map((candidate) => candidate.chunkId),
      top1Relevance: this.relevance,
    });
  }
}

class ThrowingReranker implements Reranker {
  readonly model = 'throw-reranker-test';
  calls = 0;

  rerank(
    _question: string,
    _candidates: RerankCandidate[],
  ): Promise<RerankResult> {
    this.calls += 1;
    return Promise.reject(new Error('의도된 리랭커 오류'));
  }
}

/** SSE 응답 본문(data: 프레임)을 이벤트 배열로 파싱 */
function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as SseEvent);
}

/** 라벨 순서에 의존하지 않고 Prometheus 표본 값을 읽는다. 미등록 표본은 기준값 0으로 본다. */
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
  if (!event) throw new Error(`${eventType} 이벤트가 없습니다.`);
  return event;
}

/**
 * EvidenceDetail의 안정 필드인 id(= evidence_chunks.id)만 꺼내 순서를 비교한다.
 * (동결 전 기계적 수정: DTO에 content 필드가 없어 접근자만 id로 교정 — 단언 의미 불변)
 */
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

/** 라벨에 '리랭크'가 있는 행의 마지막 숫자를 지표 값으로 읽는다. */
function renderedRerankMetricValues(markdown: string): number[] {
  const values: number[] = [];

  for (const line of markdown.split('\n')) {
    if (!line.includes('리랭크')) continue;
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

const evaluationItems: EvalSetItem[] = [
  answerableSample,
  sectionPathSample,
  abstainSample,
];

describe('spec 29: LLM 리랭커 K=30 재정렬과 관련도 게이트', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let reverseApp: INestApplication;
  let lowScoreApp: INestApplication;
  let throwApp: INestApplication;
  let gateApp: INestApplication;
  let disabledApp: INestApplication;
  let normalApp: INestApplication;
  let reverseCookie: string;
  let lowScoreCookie: string;
  let throwCookie: string;
  let gateCookie: string;
  let disabledCookie: string;
  let requestSequence = 0;

  const reverseReranker = new ReversingReranker();
  const lowScoreReranker = new KeepingReranker('low-score-reranker-test', 0);
  const throwReranker = new ThrowingReranker();
  const gateReranker = new KeepingReranker('gate-reranker-test', 10);
  const disabledReranker = new KeepingReranker('disabled-reranker-test', 10);
  const normalReranker = new KeepingReranker('normal-reranker-test', 10);

  const enabledConfig: TestRetrievalConfig = {
    distanceCutoff: LARGE_CUTOFF,
    rerankEnabled: true,
    rerankCandidates: RERANK_CANDIDATES,
    rerankScoreCutoff: SCORE_CUTOFF,
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

  beforeAll(async () => {
    [container, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    reverseApp = await createApp(reverseReranker, enabledConfig);
    lowScoreApp = await createApp(lowScoreReranker, enabledConfig);
    throwApp = await createApp(throwReranker, enabledConfig);
    gateApp = await createApp(gateReranker, {
      ...enabledConfig,
      distanceCutoff: SMALL_CUTOFF,
    });
    disabledApp = await createApp(disabledReranker, {
      ...enabledConfig,
      rerankEnabled: false,
    });
    normalApp = await createApp(normalReranker, enabledConfig);

    // 하나의 코퍼스를 여섯 앱이 공유한다. 인제스트는 한 번만 한다.
    await reverseApp.get(GuidelineIngestService).ingest(yotongGuideline);

    reverseCookie = (
      await socialSignUp(reverseApp, {
        email: 'reranker-reverse@clinic.kr',
        clinicName: '리랭크역순한의원',
        licenseNumber: 'LIC-2901',
      })
    ).cookie;
    lowScoreCookie = (
      await socialSignUp(lowScoreApp, {
        email: 'reranker-low-score@clinic.kr',
        clinicName: '리랭크저점한의원',
        licenseNumber: 'LIC-2902',
      })
    ).cookie;
    throwCookie = (
      await socialSignUp(throwApp, {
        email: 'reranker-throw@clinic.kr',
        clinicName: '리랭크폴백한의원',
        licenseNumber: 'LIC-2903',
      })
    ).cookie;
    gateCookie = (
      await socialSignUp(gateApp, {
        email: 'reranker-distance-gate@clinic.kr',
        clinicName: '리랭크거리게이트한의원',
        licenseNumber: 'LIC-2904',
      })
    ).cookie;
    disabledCookie = (
      await socialSignUp(disabledApp, {
        email: 'reranker-disabled@clinic.kr',
        clinicName: '리랭크비활성한의원',
        licenseNumber: 'LIC-2905',
      })
    ).cookie;
    await socialSignUp(normalApp, {
      email: 'reranker-normal@clinic.kr',
      clinicName: '리랭크정상한의원',
      licenseNumber: 'LIC-2906',
    });
  });

  afterAll(async () => {
    await normalApp?.close();
    await disabledApp?.close();
    await gateApp?.close();
    await throwApp?.close();
    await lowScoreApp?.close();
    await reverseApp?.close();
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
      .post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', cookie)
      .send({
        content: QUESTION,
        clientRequestId: `${prefix}-${requestSequence}`,
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

  const cosineIds = async (
    app: INestApplication,
    topK: number,
  ): Promise<string[]> => {
    const results = await app
      .get(RetrievalService)
      .search(QUESTION, undefined, topK);
    return results.map((row) => row.chunk.id);
  };

  describe('기준 1: 리랭커 반환 순서 반영', () => {
    it('기준 1: 거리 게이트 통과 시 뒤집힌 순서의 상위 5개를 노출하고 정상 완료한다', async () => {
      const cosineOrder = await cosineIds(reverseApp, RERANK_CANDIDATES);
      expect(cosineOrder.length).toBeGreaterThan(1);
      const callsBefore = reverseReranker.calls;

      const events = await askInNewConversation(
        reverseApp,
        reverseCookie,
        'req-rerank-reverse',
      );
      const retrievalCompleted = eventOf(events, 'retrieval.completed');

      expect(evidenceIds(retrievalCompleted)).toEqual(
        [...cosineOrder].reverse().slice(0, 5),
      );
      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(reverseReranker.calls - callsBefore).toBe(1);
    });
  });

  describe('기준 2: 점수 게이트 기권', () => {
    it('기준 2a: top-1 관련도가 점수 컷 미만이면 answer.abstained로 끝난다', async () => {
      const events = await askInNewConversation(
        lowScoreApp,
        lowScoreCookie,
        'req-rerank-low-score-terminal',
      );

      expect(terminalEvent(events)?.eventType).toBe('answer.abstained');
    });

    it("기준 2b: 점수 기권 메시지 status는 'ABSTAINED'다", async () => {
      const events = await askInNewConversation(
        lowScoreApp,
        lowScoreCookie,
        'req-rerank-low-score-status',
      );

      expect(terminalEvent(events)).toMatchObject({
        eventType: 'answer.abstained',
        message: expect.objectContaining({ status: 'ABSTAINED' }),
      });
    });
  });

  describe('기준 3: 점수 기권 노출 규약', () => {
    it('기준 3a: 점수 기권의 retrieval.completed는 빈 evidence를 싣는다', async () => {
      const events = await askInNewConversation(
        lowScoreApp,
        lowScoreCookie,
        'req-rerank-low-score-evidence',
      );

      expect(eventOf(events, 'retrieval.completed').evidence).toEqual([]);
    });

    it('기준 3b: 점수 기권은 beyond_cutoff와 같은 reason 문구를 전달한다', async () => {
      const events = await askInNewConversation(
        lowScoreApp,
        lowScoreCookie,
        'req-rerank-low-score-reason',
      );

      expect(eventOf(events, 'answer.abstained').reason).toBe(
        '질문과 충분히 관련된 지침 근거를 찾지 못했습니다.',
      );
    });
  });

  describe('기준 4: 점수 기권 사유 카운터', () => {
    it('기준 4: 점수 기권 1회가 rag_abstains_total{reason="beyond_cutoff"}를 1 올린다', async () => {
      const conversationId = await createConversation(
        lowScoreApp,
        lowScoreCookie,
      );
      const before = await scrapeMetrics(lowScoreApp);

      await ask(
        lowScoreApp,
        lowScoreCookie,
        conversationId,
        'req-rerank-low-score-metric',
      );
      const after = await scrapeMetrics(lowScoreApp);

      expect(
        metricValue(after, 'rag_abstains_total', {
          reason: 'beyond_cutoff',
        }) -
          metricValue(before, 'rag_abstains_total', {
            reason: 'beyond_cutoff',
          }),
      ).toBe(1);
    });
  });

  describe('기준 5: 거리 게이트의 리랭커 호출 차단', () => {
    it('기준 5: 거리 컷에 걸린 질문은 리랭커를 호출하지 않는다', async () => {
      const callsBefore = gateReranker.calls;

      const events = await askInNewConversation(
        gateApp,
        gateCookie,
        'req-rerank-distance-gate',
      );

      expect(terminalEvent(events)?.eventType).toBe('answer.abstained');
      expect(gateReranker.calls - callsBefore).toBe(0);
    });
  });

  describe('기준 6: 리랭커 오류 폴백', () => {
    it('기준 6a: 리랭커 오류 시 코사인 top-5 근거로 정상 완료한다', async () => {
      const cosineOrder = await cosineIds(throwApp, 5);
      const callsBefore = throwReranker.calls;

      const events = await askInNewConversation(
        throwApp,
        throwCookie,
        'req-rerank-fallback-completed',
      );

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(evidenceIds(eventOf(events, 'retrieval.completed'))).toEqual(
        cosineOrder,
      );
      expect(throwReranker.calls - callsBefore).toBe(1);
    });

    it('기준 6b: 리랭커 오류가 rag_rerank_total{outcome="fallback"}을 1 올린다', async () => {
      const conversationId = await createConversation(throwApp, throwCookie);
      const before = await scrapeMetrics(throwApp);

      await ask(
        throwApp,
        throwCookie,
        conversationId,
        'req-rerank-fallback-metric',
      );
      const after = await scrapeMetrics(throwApp);

      expect(
        metricValue(after, 'rag_rerank_total', { outcome: 'fallback' }) -
          metricValue(before, 'rag_rerank_total', { outcome: 'fallback' }),
      ).toBe(1);
    });
  });

  describe('기준 7: GenerationRun 검색 정책 버전', () => {
    it('기준 7a: 리랭크 성공 답변은 모델·컷을 포함한 v3 정책 버전을 기록한다', async () => {
      const before = await generationRunCount(REVERSED_V3_POLICY_VERSION);

      const events = await askInNewConversation(
        reverseApp,
        reverseCookie,
        'req-rerank-v3-policy',
      );
      const after = await generationRunCount(REVERSED_V3_POLICY_VERSION);

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(after - before).toBe(1);
    });

    it('기준 7b: 리랭커 오류 폴백 답변은 v2 정책 버전을 기록한다', async () => {
      const before = await generationRunCount(V2_POLICY_VERSION);
      const callsBefore = throwReranker.calls;

      const events = await askInNewConversation(
        throwApp,
        throwCookie,
        'req-rerank-v2-fallback-policy',
      );
      const after = await generationRunCount(V2_POLICY_VERSION);

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(throwReranker.calls - callsBefore).toBe(1);
      expect(after - before).toBe(1);
    });
  });

  describe('기준 8: 리랭크 비활성화 시 v2 동작 유지', () => {
    it('기준 8a: RETRIEVAL_RERANK_ENABLED=false면 리랭커를 호출하지 않는다', async () => {
      const callsBefore = disabledReranker.calls;

      await askInNewConversation(
        disabledApp,
        disabledCookie,
        'req-rerank-disabled-call',
      );

      expect(disabledReranker.calls - callsBefore).toBe(0);
    });

    it('기준 8b: RETRIEVAL_RERANK_ENABLED=false면 evidence가 코사인 순서를 유지한다', async () => {
      const cosineOrder = await cosineIds(disabledApp, 5);

      const events = await askInNewConversation(
        disabledApp,
        disabledCookie,
        'req-rerank-disabled-order',
      );

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(evidenceIds(eventOf(events, 'retrieval.completed'))).toEqual(
        cosineOrder,
      );
    });

    it('기준 8c: RETRIEVAL_RERANK_ENABLED=false 답변은 v2 정책 버전을 기록한다', async () => {
      const before = await generationRunCount(V2_POLICY_VERSION);

      const events = await askInNewConversation(
        disabledApp,
        disabledCookie,
        'req-rerank-disabled-policy',
      );
      const after = await generationRunCount(V2_POLICY_VERSION);

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(after - before).toBe(1);
    });
  });

  describe('기준 10: eval-rag 리랭크 지표 확장', () => {
    it('기준 10a: 순서 유지 fake의 리랭크 Recall@5·MRR@5는 유한한 숫자이며 원 지표와 같다', async () => {
      const report = await normalApp
        .get(RagEvalService)
        .evaluate(evaluationItems);

      expect(Number.isFinite(report.rerankedRecallAt5)).toBe(true);
      expect(Number.isFinite(report.rerankedMrrAt5)).toBe(true);
      expect(report.rerankedRecallAt5).toBe(report.recallAt5);
      expect(report.rerankedMrrAt5).toBe(report.mrrAt5);
    });

    it('기준 10b: 저점수 fake는 전부 점수 기권하고 정상 점수 fake는 기권하지 않는다', async () => {
      const [lowScoreReport, normalReport] = await Promise.all([
        lowScoreApp.get(RagEvalService).evaluate(evaluationItems),
        normalApp.get(RagEvalService).evaluate(evaluationItems),
      ]);

      expect(lowScoreReport.rerankedAbstainRecall).toBe(1);
      expect(lowScoreReport.rerankedOverAbstainRate).toBe(1);
      expect(normalReport.rerankedAbstainRecall).toBe(0);
      expect(normalReport.rerankedOverAbstainRate).toBe(0);
    });

    it('기준 10c: 평가 결과에 주입한 리랭크 점수 컷 6을 싣는다', async () => {
      const report = await normalApp
        .get(RagEvalService)
        .evaluate(evaluationItems);

      expect(report.rerankScoreCutoff).toBe(SCORE_CUTOFF);
    });

    it('기준 10d: 리랭커 점수가 달라도 컷·리랭크 미적용 원 순위 지표는 같다', async () => {
      const normalCallsBefore = normalReranker.calls;
      const lowScoreCallsBefore = lowScoreReranker.calls;
      const [normalReport, lowScoreReport] = await Promise.all([
        normalApp.get(RagEvalService).evaluate(evaluationItems),
        lowScoreApp.get(RagEvalService).evaluate(evaluationItems),
      ]);

      expect(lowScoreReport.recallAt5).toBe(normalReport.recallAt5);
      expect(lowScoreReport.mrrAt5).toBe(normalReport.mrrAt5);
      expect(lowScoreReport.recallAt30).toBe(normalReport.recallAt30);
      // 두 평가 모두 실제 리랭커 경로를 탔을 때만 위 비교가 비자명하다.
      expect(normalReranker.calls - normalCallsBefore).toBeGreaterThan(0);
      expect(lowScoreReranker.calls - lowScoreCallsBefore).toBeGreaterThan(0);
    });

    it('기준 10e: 마크다운 리포트에 리랭크 라벨과 네 지표의 숫자 값을 싣는다', async () => {
      const report = await normalApp
        .get(RagEvalService)
        .evaluate(evaluationItems);
      const markdown = renderEvalReport(report);
      const renderedValues = renderedRerankMetricValues(markdown);
      const expectedValues = [
        report.rerankedRecallAt5,
        report.rerankedMrrAt5,
        report.rerankedAbstainRecall,
        report.rerankedOverAbstainRate,
      ];

      expect(expectedValues.every((value) => Number.isFinite(value))).toBe(true);
      expect(renderedValues.length).toBeGreaterThanOrEqual(expectedValues.length);

      const unmatched = [...renderedValues];
      for (const expected of expectedValues) {
        const index = unmatched.findIndex(
          (rendered) => Math.abs(rendered - expected) < 0.005,
        );
        expect(index).toBeGreaterThanOrEqual(0);
        unmatched.splice(index, 1);
      }
    });
  });
});
