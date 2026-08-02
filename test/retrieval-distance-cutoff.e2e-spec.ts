// docs/specs/28 수용 기준 1~6·8·9 동결 테스트 — 구현 중 수정 금지
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
import { RetrievalService } from '../src/infrastructure/retrieval/retrieval.service';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
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

function terminalEvent(events: SseEvent[]): SseEvent | undefined {
  return events[events.length - 1];
}

function eventOf(events: SseEvent[], eventType: string): SseEvent {
  const event = events.find((candidate) => candidate.eventType === eventType);
  if (!event) throw new Error(`${eventType} 이벤트가 없습니다.`);
  return event;
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

const evaluationItems: EvalSetItem[] = [
  answerableSample,
  sectionPathSample,
  abstainSample,
];

describe('spec 28: 검색 거리 임계값 top-1 게이트', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let largeCutoffApp: INestApplication;
  let smallCutoffApp: INestApplication;
  let middleCutoffApp: INestApplication;
  let largeCutoffCookie: string;
  let smallCutoffCookie: string;
  let middleCutoffCookie: string;
  let middleCutoff: number;
  let middleSearchCount: number;
  let middleTop1Distance: number;
  let middleLastDistance: number;
  let requestSequence = 0;

  const createApp = async (distanceCutoff: number): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, EvaluationModule],
    })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(retrievalConfig.KEY)
      .useValue({ distanceCutoff })
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

    largeCutoffApp = await createApp(LARGE_CUTOFF);
    smallCutoffApp = await createApp(SMALL_CUTOFF);

    // 하나의 코퍼스를 세 앱이 공유한다. 인제스트는 한 번만 한다.
    await largeCutoffApp.get(GuidelineIngestService).ingest(yotongGuideline);

    // top-1은 통과하지만 최원거리 청크는 컷을 넘는 동적 컷을 산출한다.
    const rawResults = await largeCutoffApp
      .get(RetrievalService)
      .search(QUESTION);
    if (rawResults.length < 2) {
      throw new Error('동적 컷 검증에는 서로 다른 거리의 검색 결과가 2건 이상 필요합니다.');
    }
    middleTop1Distance = rawResults[0].distance;
    middleLastDistance = rawResults[rawResults.length - 1].distance;
    if (!(middleTop1Distance < middleLastDistance)) {
      throw new Error('top-1과 최원거리 청크 사이에 동적 컷을 만들 수 없습니다.');
    }
    middleCutoff = (middleTop1Distance + middleLastDistance) / 2;
    middleSearchCount = rawResults.length;
    middleCutoffApp = await createApp(middleCutoff);

    largeCutoffCookie = (
      await socialSignUp(largeCutoffApp, {
        email: 'retrieval-cutoff-large@clinic.kr',
        clinicName: '거리컷대조한의원',
        licenseNumber: 'LIC-2801',
      })
    ).cookie;
    smallCutoffCookie = (
      await socialSignUp(smallCutoffApp, {
        email: 'retrieval-cutoff-small@clinic.kr',
        clinicName: '거리컷기권한의원',
        licenseNumber: 'LIC-2802',
      })
    ).cookie;
    middleCutoffCookie = (
      await socialSignUp(middleCutoffApp, {
        email: 'retrieval-cutoff-middle@clinic.kr',
        clinicName: '거리컷경계한의원',
        licenseNumber: 'LIC-2803',
      })
    ).cookie;
  });

  afterAll(async () => {
    await middleCutoffApp?.close();
    await smallCutoffApp?.close();
    await largeCutoffApp?.close();
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

  const generationRunCount = async (policyVersion: string): Promise<number> => {
    const result = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM generation_runs WHERE retrieval_policy_version = $1',
      [policyVersion],
    );
    return Number(result.rows[0].count);
  };

  describe('기준 1: 컷 초과 기권', () => {
    it('기준 1a: 컷 초과 시 answer.abstained로 끝난다', async () => {
      const events = await askInNewConversation(
        smallCutoffApp,
        smallCutoffCookie,
        'req-cutoff-terminal',
      );

      expect(terminalEvent(events)?.eventType).toBe('answer.abstained');
    });

    it("기준 1b: 컷 초과 기권 메시지 status는 'ABSTAINED'다", async () => {
      const events = await askInNewConversation(
        smallCutoffApp,
        smallCutoffCookie,
        'req-cutoff-status',
      );

      expect(terminalEvent(events)).toMatchObject({
        eventType: 'answer.abstained',
        message: expect.objectContaining({ status: 'ABSTAINED' }),
      });
    });
  });

  describe('기준 2: 컷 기권의 근거 비노출', () => {
    it('기준 2: 컷 초과 시 retrieval.completed는 빈 evidence를 싣는다', async () => {
      const events = await askInNewConversation(
        smallCutoffApp,
        smallCutoffCookie,
        'req-cutoff-hidden-evidence',
      );
      const retrievalCompleted = eventOf(events, 'retrieval.completed');

      expect(retrievalCompleted.evidence).toEqual([]);
    });
  });

  describe('기준 3: top-1 통과 시 전량 유지', () => {
    it('기준 3: top-1과 최원거리 사이의 컷을 통과하면 검색 결과 전체를 근거로 유지한다', async () => {
      expect(middleTop1Distance).toBeLessThan(middleCutoff);
      expect(middleLastDistance).toBeGreaterThan(middleCutoff);

      const events = await askInNewConversation(
        middleCutoffApp,
        middleCutoffCookie,
        'req-cutoff-top1-only',
      );
      const retrievalCompleted = eventOf(events, 'retrieval.completed');

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(retrievalCompleted.evidence).toHaveLength(middleSearchCount);
    });
  });

  describe('기준 4: 기권 사유 카운터', () => {
    it('기준 4a: 근거 0건 기권은 rag_abstains_total{reason="no_candidates"}를 1 올린다', async () => {
      const conversationId = await createConversation(
        largeCutoffApp,
        largeCutoffCookie,
      );
      const before = await scrapeMetrics(largeCutoffApp);

      await withLegacyEmbeddings(() =>
        ask(
          largeCutoffApp,
          largeCutoffCookie,
          conversationId,
          'req-no-candidates-metric',
        ),
      );
      const after = await scrapeMetrics(largeCutoffApp);

      expect(
        metricValue(after, 'rag_abstains_total', {
          reason: 'no_candidates',
        }) -
          metricValue(before, 'rag_abstains_total', {
            reason: 'no_candidates',
          }),
      ).toBe(1);
    });

    it('기준 4b: 컷 기권은 rag_abstains_total{reason="beyond_cutoff"}를 1 올린다', async () => {
      const conversationId = await createConversation(
        smallCutoffApp,
        smallCutoffCookie,
      );
      const before = await scrapeMetrics(smallCutoffApp);

      await ask(
        smallCutoffApp,
        smallCutoffCookie,
        conversationId,
        'req-beyond-cutoff-metric',
      );
      const after = await scrapeMetrics(smallCutoffApp);

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

  describe('기준 5: 기권 reason 문구 분리', () => {
    it('기준 5a·5b: 근거 0건과 컷 초과 기권은 서로 다른 reason을 전달한다', async () => {
      const noCandidatesEvents = await withLegacyEmbeddings(() =>
        askInNewConversation(
          largeCutoffApp,
          largeCutoffCookie,
          'req-no-candidates-reason',
        ),
      );
      const beyondCutoffEvents = await askInNewConversation(
        smallCutoffApp,
        smallCutoffCookie,
        'req-beyond-cutoff-reason',
      );

      expect(eventOf(noCandidatesEvents, 'answer.abstained').reason).toBe(
        '검색 조건에 해당하는 지침 근거를 찾지 못했습니다.',
      );
      expect(eventOf(beyondCutoffEvents, 'answer.abstained').reason).toBe(
        '질문과 충분히 관련된 지침 근거를 찾지 못했습니다.',
      );
    });
  });

  describe('기준 6: 실사용 컷이 포함된 정책 버전 기록', () => {
    it('기준 6: 정상 답변의 GenerationRun에 주입된 컷을 포함한 v2 정책 버전을 기록한다', async () => {
      const expectedPolicyVersion =
        'cosine-top5-cut2-v2/fake-embedding-v1';
      const before = await generationRunCount(expectedPolicyVersion);

      const events = await askInNewConversation(
        largeCutoffApp,
        largeCutoffCookie,
        'req-cutoff-policy-version',
      );
      const after = await generationRunCount(expectedPolicyVersion);

      expect(terminalEvent(events)?.eventType).toBe('answer.completed');
      expect(after - before).toBe(1);
    });
  });

  describe('기준 8: 평가 기권 지표', () => {
    it('기준 8a: 큰 컷에서 기권 재현율과 과잉 기권률은 모두 0이다', async () => {
      const report = await largeCutoffApp
        .get(RagEvalService)
        .evaluate(evaluationItems);

      expect(report.abstainRecall).toBe(0);
      expect(report.overAbstainRate).toBe(0);
    });

    it('기준 8b: 작은 컷에서 기권 재현율과 과잉 기권률은 모두 1이다', async () => {
      const report = await smallCutoffApp
        .get(RagEvalService)
        .evaluate(evaluationItems);

      expect(report.abstainRecall).toBe(1);
      expect(report.overAbstainRate).toBe(1);
    });

    it('기준 8c: 평가 리포트에 각 앱에 주입한 거리 컷을 싣는다', async () => {
      const [largeReport, smallReport] = await Promise.all([
        largeCutoffApp.get(RagEvalService).evaluate(evaluationItems),
        smallCutoffApp.get(RagEvalService).evaluate(evaluationItems),
      ]);

      expect(largeReport.distanceCutoff).toBe(LARGE_CUTOFF);
      expect(smallReport.distanceCutoff).toBe(SMALL_CUTOFF);
    });

    it('기준 8d: 마크다운 리포트에 기권 재현율·과잉 기권률의 라벨과 값을 싣는다', async () => {
      const report = await smallCutoffApp
        .get(RagEvalService)
        .evaluate(evaluationItems);
      const markdown = renderEvalReport(report);

      expect(markdown).toContain('기권 재현율');
      expect(renderedMetricValue(markdown, '기권 재현율')).toBeCloseTo(
        report.abstainRecall,
        2,
      );
      expect(markdown).toContain('과잉 기권률');
      expect(renderedMetricValue(markdown, '과잉 기권률')).toBeCloseTo(
        report.overAbstainRate,
        2,
      );
    });
  });

  describe('기준 9: 순위 지표의 컷 불변성', () => {
    it('기준 9: 컷을 바꿔도 Recall@5·MRR@5·Recall@30은 변하지 않는다', async () => {
      const [largeReport, smallReport] = await Promise.all([
        largeCutoffApp.get(RagEvalService).evaluate(evaluationItems),
        smallCutoffApp.get(RagEvalService).evaluate(evaluationItems),
      ]);

      expect(smallReport.recallAt5).toBe(largeReport.recallAt5);
      expect(smallReport.mrrAt5).toBe(largeReport.mrrAt5);
      expect(smallReport.recallAt30).toBe(largeReport.recallAt30);
    });
  });
});
