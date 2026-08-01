// docs/specs/27 수용 기준 1·2·4·5 동결 테스트 — 구현 중 수정 금지
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
import {
  LabelResolutionError,
  LabelResolver,
} from '../src/domain/evaluation/label-resolver';
import { RagEvalService } from '../src/domain/evaluation/rag-eval.service';
import type { RagEvalReport } from '../src/domain/evaluation/rag-eval.service';
import { renderEvalReport } from '../src/domain/evaluation/rag-eval.report';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { RetrievalService } from '../src/infrastructure/retrieval/retrieval.service';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import {
  abstainSample,
  answerableSample,
  sectionPathSample,
  unresolvableSample,
} from './fixtures/rag-eval/evalset.sample';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { yotongGuideline } from './fixtures/guideline-samples';
import { socialSignUp } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const QUESTION = '만성 요통 환자에게 침 치료가 효과적인가요?';
const R2_CONTENT = '급성 요통 환자에게 전침 병행 치료를 고려할 수 있다.';

interface SseEvent {
  eventType: string;
  [key: string]: unknown;
}

interface PrometheusLabels {
  [key: string]: string;
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

function terminalEventType(events: SseEvent[]): string | undefined {
  return events[events.length - 1]?.eventType;
}

function expectUnitInterval(value: number): void {
  expect(typeof value).toBe('number');
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(1);
}

/** 소수 또는 백분율로 렌더링된 지표를 원래 리포트 값과 비교한다. */
function renderedMetricValue(markdown: string, label: string): number {
  for (const line of markdown.split('\n')) {
    const labelIndex = line.indexOf(label);
    if (labelIndex === -1) continue;

    const suffix = line.slice(labelIndex + label.length);
    const match = suffix.match(/(?<![@a-zA-Z0-9_])(-?\d+(?:\.\d+)?)\s*(%?)/);
    if (!match) continue;

    const value = Number(match[1]);
    return match[2] === '%' ? value / 100 : value;
  }

  throw new Error(`리포트의 ${label} 행에 숫자 값이 없습니다.`);
}

const missedAnswerableSample: EvalSetItem = {
  id: 'eval-answerable-missed-r2',
  kind: 'answerable',
  question: '급성 요통에서 전침 병행 치료를 고려할 수 있나요?',
  expectedEvidence: [
    {
      guidelineTitle: '요통 한의표준임상진료지침',
      publisher: '한국한의약진흥원',
      recommendationNumber: 'R2',
    },
  ],
  status: 'approved',
  origin: 'manual',
};

const evaluationItems: EvalSetItem[] = [
  answerableSample,
  sectionPathSample,
  missedAnswerableSample,
  abstainSample,
];

describe('spec 27: RAG 평가 기반', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let cookie: string;
  let requestSequence = 0;

  beforeAll(async () => {
    [container, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, EvaluationModule],
    })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();

    await app.get(GuidelineIngestService).ingest(yotongGuideline);
    cookie = (
      await socialSignUp(app, { email: 'rag-eval-baseline@clinic.kr' })
    ).cookie;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  const scrapeMetrics = async (): Promise<string> => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/metrics')
      .expect(200);
    return response.text;
  };

  const createConversation = async (): Promise<string> => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ type: 'GUIDELINE_QA' })
      .expect(201);
    return created.body.data.id as string;
  };

  const ask = async (conversationId: string, prefix: string): Promise<SseEvent[]> => {
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

  const withLegacyEmbeddings = async <T>(work: () => Promise<T>): Promise<T> => {
    await pool.query('UPDATE evidence_chunks SET embedding_model = $1', [
      'legacy-model',
    ]);
    try {
      return await work();
    } finally {
      await pool.query('UPDATE evidence_chunks SET embedding_model = $1', [
        'fake-embedding-v1',
      ]);
    }
  };

  describe('기준 1: 답변 결말 메트릭', () => {
    it('기준 1a: 정상 답변은 rag_answers_total{outcome="answered"}를 올린다', async () => {
      const conversationId = await createConversation();
      const before = await scrapeMetrics();

      const events = await ask(conversationId, 'req-rag-answered');
      const after = await scrapeMetrics();

      expect(terminalEventType(events)).toBe('answer.completed');
      expect(
        metricValue(after, 'rag_answers_total', { outcome: 'answered' }) -
          metricValue(before, 'rag_answers_total', { outcome: 'answered' }),
      ).toBe(1);
    });

    it('기준 1b: 근거 0건 기권은 rag_answers_total{outcome="abstained"}를 올린다', async () => {
      const conversationId = await createConversation();
      const before = await scrapeMetrics();

      const events = await withLegacyEmbeddings(() =>
        ask(conversationId, 'req-rag-abstained'),
      );
      const after = await scrapeMetrics();

      expect(terminalEventType(events)).toBe('answer.abstained');
      expect(
        metricValue(after, 'rag_answers_total', { outcome: 'abstained' }) -
          metricValue(before, 'rag_answers_total', { outcome: 'abstained' }),
      ).toBe(1);
    });

    it('기준 1c: 정상 답변과 기권 모두 SSE completed이며 rag_answers_total에서만 갈린다', async () => {
      const conversationId = await createConversation();
      const before = await scrapeMetrics();

      const answeredEvents = await ask(conversationId, 'req-rag-axis-answered');
      const afterAnswered = await scrapeMetrics();

      expect(terminalEventType(answeredEvents)).toBe('answer.completed');
      expect(
        metricValue(afterAnswered, 'sse_streams_total', { outcome: 'completed' }) -
          metricValue(before, 'sse_streams_total', { outcome: 'completed' }),
      ).toBe(1);
      expect(
        metricValue(afterAnswered, 'rag_answers_total', { outcome: 'answered' }) -
          metricValue(before, 'rag_answers_total', { outcome: 'answered' }),
      ).toBe(1);

      const abstainedEvents = await withLegacyEmbeddings(() =>
        ask(conversationId, 'req-rag-axis-abstained'),
      );
      const afterAbstained = await scrapeMetrics();

      expect(terminalEventType(abstainedEvents)).toBe('answer.abstained');
      expect(
        metricValue(afterAbstained, 'sse_streams_total', { outcome: 'completed' }) -
          metricValue(afterAnswered, 'sse_streams_total', { outcome: 'completed' }),
      ).toBe(1);
      expect(
        metricValue(afterAbstained, 'rag_answers_total', { outcome: 'abstained' }) -
          metricValue(afterAnswered, 'rag_answers_total', { outcome: 'abstained' }),
      ).toBe(1);
    });
  });

  describe('기준 2: 검색 단계 메트릭', () => {
    it('기준 2a: 검색은 rag_retrieval_duration_seconds{stage="embed"} 관측치를 남긴다', async () => {
      const before = await scrapeMetrics();
      await app.get(RetrievalService).search(QUESTION);
      const after = await scrapeMetrics();

      expect(
        metricValue(after, 'rag_retrieval_duration_seconds_count', {
          stage: 'embed',
        }) -
          metricValue(before, 'rag_retrieval_duration_seconds_count', {
            stage: 'embed',
          }),
      ).toBe(1);
    });

    it('기준 2b: 검색은 rag_retrieval_duration_seconds{stage="vector_search"} 관측치를 남긴다', async () => {
      const before = await scrapeMetrics();
      await app.get(RetrievalService).search(QUESTION);
      const after = await scrapeMetrics();

      expect(
        metricValue(after, 'rag_retrieval_duration_seconds_count', {
          stage: 'vector_search',
        }) -
          metricValue(before, 'rag_retrieval_duration_seconds_count', {
            stage: 'vector_search',
          }),
      ).toBe(1);
    });

    it('기준 2c: 검색은 반환 청크 수를 rag_retrieved_chunks에 기록한다', async () => {
      const before = await scrapeMetrics();
      const results = await app.get(RetrievalService).search(QUESTION);
      const after = await scrapeMetrics();

      expect(
        metricValue(after, 'rag_retrieved_chunks_count') -
          metricValue(before, 'rag_retrieved_chunks_count'),
      ).toBe(1);
      expect(
        metricValue(after, 'rag_retrieved_chunks_sum') -
          metricValue(before, 'rag_retrieved_chunks_sum'),
      ).toBe(results.length);
    });

    it('기준 2c: 검색 결과가 0건이어도 rag_retrieved_chunks 관측을 남긴다', async () => {
      await withLegacyEmbeddings(async () => {
        const before = await scrapeMetrics();
        const results = await app.get(RetrievalService).search(QUESTION);
        const after = await scrapeMetrics();

        expect(results).toHaveLength(0);
        expect(
          metricValue(after, 'rag_retrieved_chunks_count') -
            metricValue(before, 'rag_retrieved_chunks_count'),
        ).toBe(1);
        expect(
          metricValue(after, 'rag_retrieved_chunks_sum') -
            metricValue(before, 'rag_retrieved_chunks_sum'),
        ).toBe(0);
      });
    });

    it('기준 2d: 검색은 top-1 코사인 거리를 rag_top1_distance에 기록한다', async () => {
      const before = await scrapeMetrics();
      const results = await app.get(RetrievalService).search(QUESTION);
      const after = await scrapeMetrics();

      expect(results.length).toBeGreaterThan(0);
      expect(
        metricValue(after, 'rag_top1_distance_count') -
          metricValue(before, 'rag_top1_distance_count'),
      ).toBe(1);
      expect(
        metricValue(after, 'rag_top1_distance_sum') -
          metricValue(before, 'rag_top1_distance_sum'),
      ).toBeCloseTo(results[0].distance, 10);
    });
  });

  describe('기준 4: 안정 키 라벨 해석', () => {
    it('기준 4 대조군: 실제 코퍼스의 권고번호·섹션경로 라벨은 청크 ID로 해석한다', async () => {
      const resolved = await app
        .get(LabelResolver)
        .resolve([answerableSample, sectionPathSample]);

      expect(resolved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            itemId: answerableSample.id,
            chunkIds: expect.arrayContaining([expect.any(String)]),
          }),
          expect.objectContaining({
            itemId: sectionPathSample.id,
            chunkIds: expect.arrayContaining([expect.any(String)]),
          }),
        ]),
      );
    });

    it('기준 4a: 0건 라벨을 건너뛰거나 부분 반환하지 않고 LabelResolutionError로 거부한다', async () => {
      await expect(
        app
          .get(LabelResolver)
          .resolve([answerableSample, unresolvableSample]),
      ).rejects.toBeInstanceOf(LabelResolutionError);
    });

    it('기준 4b: 라벨 해석 에러 메시지에 실패 문항 id를 싣는다', async () => {
      await expect(
        app.get(LabelResolver).resolve([unresolvableSample]),
      ).rejects.toThrow(unresolvableSample.id);
    });

    it('기준 4b: 라벨 해석 에러 메시지에 실패한 안정 키를 싣는다', async () => {
      await expect(
        app.get(LabelResolver).resolve([unresolvableSample]),
      ).rejects.toThrow('없는 지침');
    });
  });

  describe('기준 5: 기준선 산출과 마크다운 리포트', () => {
    beforeEach(async () => {
      const changed = await pool.query(
        'UPDATE evidence_chunks SET embedding_model = $1 WHERE content = $2',
        ['legacy-model', R2_CONTENT],
      );
      expect(changed.rowCount).toBe(1);
    });

    afterEach(async () => {
      await pool.query(
        'UPDATE evidence_chunks SET embedding_model = $1 WHERE content = $2',
        ['fake-embedding-v1', R2_CONTENT],
      );
    });

    it('기준 5a: Recall@5·MRR@5·Recall@30을 각각 0~1 범위의 숫자로 산출한다', async () => {
      const report = await app.get(RagEvalService).evaluate(evaluationItems);

      expectUnitInterval(report.recallAt5);
      expectUnitInterval(report.mrrAt5);
      expectUnitInterval(report.recallAt30);
    });

    it('기준 5b: 같은 평가셋을 두 번 실행하면 세 지표가 동일하다', async () => {
      const evaluator = app.get(RagEvalService);
      const first = await evaluator.evaluate(evaluationItems);
      const second = await evaluator.evaluate(evaluationItems);

      expect(second.recallAt5).toBe(first.recallAt5);
      expect(second.mrrAt5).toBe(first.mrrAt5);
      expect(second.recallAt30).toBe(first.recallAt30);
    });

    it('기준 5c: 마크다운 리포트에 세 지표의 이름과 산출값을 싣는다', async () => {
      const report = await app.get(RagEvalService).evaluate(evaluationItems);
      const markdown = renderEvalReport(report);

      expect(markdown).toContain('Recall@5');
      expect(renderedMetricValue(markdown, 'Recall@5')).toBeCloseTo(
        report.recallAt5,
        2,
      );
      expect(markdown).toContain('MRR@5');
      expect(renderedMetricValue(markdown, 'MRR@5')).toBeCloseTo(
        report.mrrAt5,
        2,
      );
      expect(markdown).toContain('Recall@30');
      expect(renderedMetricValue(markdown, 'Recall@30')).toBeCloseTo(
        report.recallAt30,
        2,
      );
    });

    it('기준 5d: 마크다운 리포트에 top-30에서 기대 근거를 못 찾은 문항 id를 나열한다', async () => {
      const report = await app.get(RagEvalService).evaluate(evaluationItems);
      const markdown = renderEvalReport(report);

      expect(report.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            itemId: missedAnswerableSample.id,
            foundAtRank: null,
          }),
        ]),
      );
      expect(markdown).toContain(missedAnswerableSample.id);
    });

    it('기준 5e: 마크다운 리포트에 answerable·abstain별 거리 분포를 싣는다', async () => {
      const report = await app.get(RagEvalService).evaluate(evaluationItems);
      const markdown = renderEvalReport(report);

      const answerableDistances = report.distances.find(
        ({ kind }) => kind === 'answerable',
      );
      const abstainDistances = report.distances.find(
        ({ kind }) => kind === 'abstain',
      );

      expect(report.distances).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'answerable',
            p10: expect.any(Number),
            p50: expect.any(Number),
            p90: expect.any(Number),
          }),
          expect.objectContaining({
            kind: 'abstain',
            p10: expect.any(Number),
            p50: expect.any(Number),
            p90: expect.any(Number),
          }),
        ]),
      );
      expect(answerableDistances?.count).toBe(3);
      expect(abstainDistances?.count).toBe(1);
      expect(
        [
          answerableDistances?.p10,
          answerableDistances?.p50,
          answerableDistances?.p90,
          abstainDistances?.p10,
          abstainDistances?.p50,
          abstainDistances?.p90,
        ].every((value) => typeof value === 'number' && Number.isFinite(value)),
      ).toBe(true);
      expect(markdown).toContain('answerable');
      expect(markdown).toContain('abstain');
      expect(markdown).toMatch(/p10/i);
      expect(markdown).toMatch(/p50/i);
      expect(markdown).toMatch(/p90/i);
    });

    it('기준 5e: 마크다운 리포트에 retrievalPolicyVersion을 싣는다', async () => {
      const report: RagEvalReport = await app
        .get(RagEvalService)
        .evaluate(evaluationItems);
      const markdown = renderEvalReport(report);

      // spec 28에서 정책 버전이 실사용 컷을 포함한 v2로 범프됐다 — 컷 2는 setup-env의 중립값
      expect(report.retrievalPolicyVersion).toBe(
        'cosine-top5-cut2-v2/fake-embedding-v1',
      );
      expect(markdown).toContain('retrievalPolicyVersion');
      expect(markdown).toContain(report.retrievalPolicyVersion);
    });
  });
});
