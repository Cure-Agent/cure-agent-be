// docs/specs/40 수용 기준 1~15·17·19~23·27·28 동결 테스트 — 구현 중 수정 금지
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  RedisContainer,
  StartedRedisContainer,
} from '@testcontainers/redis';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { retrievalConfig } from '../src/global/config/retrieval.config';
import {
  LLM_PROVIDERS,
  type LlmAnswerChunk,
  type LlmAnswerVerdict,
  type LlmProvider,
  type LlmStreamRequest,
} from '../src/infrastructure/llm/llm-provider.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import {
  RERANKER,
  type RerankCandidate,
  type Reranker,
  type RerankResult,
} from '../src/infrastructure/retrieval/reranker.port';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { yotongGuideline } from './fixtures/guideline-samples';
import { socialSignUp } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const QUESTION = '만성 요통 환자에게 침 치료가 효과적인가요?';
const INSUFFICIENT_REASON =
  '찾은 지침 근거만으로는 이 질문에 답하기 어렵습니다.';
const BEYOND_CUTOFF_REASON =
  '질문과 충분히 관련된 지침 근거를 찾지 못했습니다.';
const INTERNAL_MISSING_ASPECT = '내부-누락축-절대노출금지-40';
const LARGE_CUTOFF = 2;
const SMALL_CUTOFF = 0.000001;
const SCORE_CUTOFF = 6;
const RERANK_CANDIDATES = 30;
const GENERATED_POLICY_VERSION =
  'cosine-top30-rerank-answerability-reranker-test-cut2-score6-v3/fake-embedding-v1';

const GATED_DELTAS = [
  '근거가 부족하지만 관련 내용을 적습니다 [1]. ',
  '추가로 무관한 근거도 인용합니다 [2].',
];

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

type ConversationType = 'GUIDELINE_QA' | 'PATIENT_GUIDANCE';

class DeterministicAnswerProvider implements LlmProvider {
  readonly model: string;

  constructor(
    readonly name: string,
    private readonly verdict: LlmAnswerVerdict | undefined,
    private readonly deltas: string[],
  ) {
    this.model = `${name}-model`;
  }

  async *streamAnswer(
    _request: LlmStreamRequest,
  ): AsyncIterable<LlmAnswerChunk> {
    if (this.verdict !== undefined) {
      yield {
        kind: 'verdict',
        insufficientEvidence: this.verdict.insufficientEvidence,
        missingAspects: [...this.verdict.missingAspects],
      };
    }

    for (const text of this.deltas) {
      yield { kind: 'delta', text };
    }
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

/** SSE 응답 본문의 data 프레임을 이벤트 배열로 바꾼다. */
function parseSse(body: string): SseEvent[] {
  return body
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => frame.split(/\r?\n/))
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as SseEvent);
}

/** 라벨 순서에 의존하지 않고 프로메테우스 표본을 읽는다. */
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

function terminalEvent(events: SseEvent[]): SseEvent {
  const terminal = events[events.length - 1];
  if (!terminal) throw new Error('종결 이벤트가 없습니다.');
  return terminal;
}

function eventOf(events: SseEvent[], eventType: string): SseEvent {
  const event = events.find((candidate) => candidate.eventType === eventType);
  if (!event) throw new Error(`${eventType} 이벤트가 없습니다.`);
  return event;
}

function abstainedOf(events: SseEvent[]): SseEvent {
  return eventOf(events, 'answer.abstained');
}

function assistantMessageIdOf(events: SseEvent[]): string {
  const value = eventOf(events, 'message.accepted').assistantMessageId;
  if (typeof value !== 'string') {
    throw new Error('message.accepted에 assistantMessageId가 없습니다.');
  }
  return value;
}

function evidenceOf(events: SseEvent[]): unknown[] {
  const evidence = eventOf(events, 'retrieval.completed').evidence;
  if (!Array.isArray(evidence)) {
    throw new Error('retrieval.completed evidence가 배열이 아닙니다.');
  }
  return evidence;
}

function reasonOf(events: SseEvent[]): string {
  const reason = abstainedOf(events).reason;
  if (typeof reason !== 'string') {
    throw new Error('answer.abstained reason이 문자열이 아닙니다.');
  }
  return reason;
}

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

describe('spec 40: 답변가능성 생성 게이트', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let gateApp: INestApplication;
  let emptyAspectsApp: INestApplication;
  let failOpenApp: INestApplication;
  let incrementalApp: INestApplication;
  let offNormalApp: INestApplication;
  let distanceGateApp: INestApplication;
  let scoreGateApp: INestApplication;
  let gateCookie: string;
  let emptyAspectsCookie: string;
  let failOpenCookie: string;
  let incrementalCookie: string;
  let offNormalCookie: string;
  let distanceGateCookie: string;
  let scoreGateCookie: string;

  let gateEvents: SseEvent[];
  let failOpenEvents: SseEvent[];
  let incrementalEvents: SseEvent[];
  let offNormalEvents: SseEvent[];
  let distanceGateEvents: SseEvent[];
  let scoreGateEvents: SseEvent[];
  let modelCauseEvents: SseEvent[];
  let emptyCauseEvents: SseEvent[];
  let patientGateEvents: SseEvent[];
  let insufficientAbstainMetricDelta = Number.NaN;
  let modelCauseMetricDelta = Number.NaN;
  let emptyCauseMetricDelta = Number.NaN;
  let patientSnapshotDelta = Number.NaN;
  let patientGuidanceCount = Number.NaN;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalAnswerabilityGate =
    process.env.LLM_ANSWERABILITY_GATE_ENABLED;

  const highScoreReranker = new KeepingReranker(
    'answerability-reranker-test',
    10,
  );
  const lowScoreReranker = new KeepingReranker(
    'answerability-low-score-test',
    0,
  );

  const passConfig: TestRetrievalConfig = {
    distanceCutoff: LARGE_CUTOFF,
    rerankEnabled: true,
    rerankCandidates: RERANK_CANDIDATES,
    rerankScoreCutoff: SCORE_CUTOFF,
    hybridEnabled: false,
  };

  const gateProvider = new DeterministicAnswerProvider(
    'answerability-gate-fake',
    {
      insufficientEvidence: true,
      missingAspects: [INTERNAL_MISSING_ASPECT],
    },
    GATED_DELTAS,
  );
  const emptyAspectsProvider = new DeterministicAnswerProvider(
    'answerability-empty-aspects-fake',
    { insufficientEvidence: true, missingAspects: [] },
    GATED_DELTAS,
  );
  const noVerdictProvider = new DeterministicAnswerProvider(
    'answerability-no-verdict-fake',
    undefined,
    ['침 치료는 통증 감소에 ', '도움이 됩니다 [1].'],
  );
  const answerableVerdictProvider = new DeterministicAnswerProvider(
    'answerability-false-verdict-fake',
    { insufficientEvidence: false, missingAspects: [] },
    ['침 치료는 ', '만성 요통의 통증 감소와 ', '기능 개선에 권고됩니다 [1].'],
  );

  const withGateEnv = async <T>(
    enabled: boolean,
    work: () => Promise<T>,
  ): Promise<T> => {
    const original = process.env.LLM_ANSWERABILITY_GATE_ENABLED;
    process.env.LLM_ANSWERABILITY_GATE_ENABLED = enabled ? 'true' : 'false';
    try {
      return await work();
    } finally {
      restoreEnv('LLM_ANSWERABILITY_GATE_ENABLED', original);
    }
  };

  const createApp = async (
    provider: LlmProvider,
    reranker: Reranker,
    config: TestRetrievalConfig,
    gateEnabled: boolean,
  ): Promise<INestApplication> =>
    withGateEnv(gateEnabled, async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(OAuthProviderRegistry)
        .useClass(FakeOAuthProviderRegistry)
        .overrideProvider(LLM_PROVIDERS)
        .useValue([provider])
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
    type: ConversationType = 'GUIDELINE_QA',
    patientId?: string,
  ): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', cookie)
      .send(patientId === undefined ? { type } : { type, patientId })
      .expect(201);
    return response.body.data.id as string;
  };

  const ask = async (
    app: INestApplication,
    cookie: string,
    conversationId: string,
  ): Promise<SseEvent[]> => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ content: QUESTION, clientRequestId: randomUUID() })
      .expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    return parseSse(response.text);
  };

  const askInNewConversation = async (
    app: INestApplication,
    cookie: string,
  ): Promise<SseEvent[]> => {
    const conversationId = await createConversation(app, cookie);
    return ask(app, cookie, conversationId);
  };

  const createPatient = async (
    app: INestApplication,
    cookie: string,
  ): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({
        caseLabel: `SPEC40-${randomUUID()}`,
        birthYear: 1980,
        sex: 'FEMALE',
        heightCm: 165,
        weightKg: 62,
        waistCm: 80,
        diagnoses: ['만성 요통'],
        medications: ['암로디핀정'],
        allergies: [],
        clinicalNotes: '만성 요통에 대한 침 치료 참고안을 검토한다.',
      })
      .expect(201);
    return response.body.data.id as string;
  };

  const snapshotCount = async (patientId: string): Promise<number> => {
    const result = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM patient_profile_snapshots WHERE patient_id = $1',
      [patientId],
    );
    return result.rows[0].count;
  };

  beforeAll(async () => {
    [postgresContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);

    process.env.DATABASE_URL = postgresContainer.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();
    process.env.OPENAI_API_KEY = '';

    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    gateApp = await createApp(
      gateProvider,
      highScoreReranker,
      passConfig,
      true,
    );
    emptyAspectsApp = await createApp(
      emptyAspectsProvider,
      highScoreReranker,
      passConfig,
      true,
    );
    failOpenApp = await createApp(
      noVerdictProvider,
      highScoreReranker,
      passConfig,
      true,
    );
    incrementalApp = await createApp(
      answerableVerdictProvider,
      highScoreReranker,
      passConfig,
      true,
    );
    offNormalApp = await createApp(
      noVerdictProvider,
      highScoreReranker,
      passConfig,
      false,
    );
    distanceGateApp = await createApp(
      noVerdictProvider,
      highScoreReranker,
      { ...passConfig, distanceCutoff: SMALL_CUTOFF },
      false,
    );
    scoreGateApp = await createApp(
      noVerdictProvider,
      lowScoreReranker,
      passConfig,
      false,
    );

    await gateApp.get(GuidelineIngestService).ingest(yotongGuideline);

    gateCookie = (
      await socialSignUp(gateApp, {
        email: 'spec40-gate@clinic.kr',
        clinicName: '생성게이트한의원',
        licenseNumber: 'LIC-4001',
      })
    ).cookie;
    emptyAspectsCookie = (
      await socialSignUp(emptyAspectsApp, {
        email: 'spec40-empty@clinic.kr',
        clinicName: '빈축게이트한의원',
        licenseNumber: 'LIC-4002',
      })
    ).cookie;
    failOpenCookie = (
      await socialSignUp(failOpenApp, {
        email: 'spec40-fail-open@clinic.kr',
        clinicName: '미판정한의원',
        licenseNumber: 'LIC-4003',
      })
    ).cookie;
    incrementalCookie = (
      await socialSignUp(incrementalApp, {
        email: 'spec40-incremental@clinic.kr',
        clinicName: '증분답변한의원',
        licenseNumber: 'LIC-4004',
      })
    ).cookie;
    offNormalCookie = (
      await socialSignUp(offNormalApp, {
        email: 'spec40-off@clinic.kr',
        clinicName: '게이트비활성한의원',
        licenseNumber: 'LIC-4005',
      })
    ).cookie;
    distanceGateCookie = (
      await socialSignUp(distanceGateApp, {
        email: 'spec40-distance@clinic.kr',
        clinicName: '거리게이트한의원',
        licenseNumber: 'LIC-4006',
      })
    ).cookie;
    scoreGateCookie = (
      await socialSignUp(scoreGateApp, {
        email: 'spec40-score@clinic.kr',
        clinicName: '점수게이트한의원',
        licenseNumber: 'LIC-4007',
      })
    ).cookie;

    gateEvents = await askInNewConversation(gateApp, gateCookie);
    failOpenEvents = await askInNewConversation(failOpenApp, failOpenCookie);
    incrementalEvents = await askInNewConversation(
      incrementalApp,
      incrementalCookie,
    );
    offNormalEvents = await askInNewConversation(offNormalApp, offNormalCookie);
    distanceGateEvents = await askInNewConversation(
      distanceGateApp,
      distanceGateCookie,
    );
    scoreGateEvents = await askInNewConversation(
      scoreGateApp,
      scoreGateCookie,
    );

    const modelMetricsBefore = await scrapeMetrics(gateApp);
    modelCauseEvents = await askInNewConversation(gateApp, gateCookie);
    const modelMetricsAfter = await scrapeMetrics(gateApp);
    insufficientAbstainMetricDelta =
      metricValue(modelMetricsAfter, 'rag_abstains_total', {
        reason: 'insufficient_evidence',
      }) -
      metricValue(modelMetricsBefore, 'rag_abstains_total', {
        reason: 'insufficient_evidence',
      });
    modelCauseMetricDelta =
      metricValue(modelMetricsAfter, 'rag_generation_gate_total', {
        cause: 'model_verdict',
      }) -
      metricValue(modelMetricsBefore, 'rag_generation_gate_total', {
        cause: 'model_verdict',
      });

    const emptyMetricsBefore = await scrapeMetrics(emptyAspectsApp);
    emptyCauseEvents = await askInNewConversation(
      emptyAspectsApp,
      emptyAspectsCookie,
    );
    const emptyMetricsAfter = await scrapeMetrics(emptyAspectsApp);
    emptyCauseMetricDelta =
      metricValue(emptyMetricsAfter, 'rag_generation_gate_total', {
        cause: 'empty_aspects',
      }) -
      metricValue(emptyMetricsBefore, 'rag_generation_gate_total', {
        cause: 'empty_aspects',
      });

    const patientId = await createPatient(gateApp, gateCookie);
    const patientConversationId = await createConversation(
      gateApp,
      gateCookie,
      'PATIENT_GUIDANCE',
      patientId,
    );
    const snapshotsBefore = await snapshotCount(patientId);
    patientGateEvents = await ask(
      gateApp,
      gateCookie,
      patientConversationId,
    );
    const snapshotsAfter = await snapshotCount(patientId);
    patientSnapshotDelta = snapshotsAfter - snapshotsBefore;

    const guidanceResult = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM clinical_guidances WHERE message_id = $1',
      [assistantMessageIdOf(patientGateEvents)],
    );
    patientGuidanceCount = guidanceResult.rows[0].count;
  });

  afterAll(async () => {
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('REDIS_URL', originalRedisUrl);
    restoreEnv('OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnv(
      'LLM_ANSWERABILITY_GATE_ENABLED',
      originalAnswerabilityGate,
    );

    await scoreGateApp?.close();
    await distanceGateApp?.close();
    await offNormalApp?.close();
    await incrementalApp?.close();
    await failOpenApp?.close();
    await emptyAspectsApp?.close();
    await gateApp?.close();
    await pool?.end();
    await Promise.all([
      postgresContainer?.stop(),
      redisContainer?.stop(),
    ]);
  });

  it('기준 1: 충분하지 않다는 verdict는 answer.abstained로 종결한다', () => {
    expect(terminalEvent(gateEvents).eventType).toBe('answer.abstained');
  });

  it('기준 2: 생성 게이트 기권 메시지는 SSE와 DB 모두 ABSTAINED다', async () => {
    const messageId = assistantMessageIdOf(gateEvents);
    expect(abstainedOf(gateEvents)).toMatchObject({
      message: expect.objectContaining({ id: messageId, status: 'ABSTAINED' }),
    });

    const result = await pool.query<{ status: string }>(
      'SELECT status FROM messages WHERE id = $1',
      [messageId],
    );
    expect(result.rows).toEqual([{ status: 'ABSTAINED' }]);
  });

  it('기준 3: 인용 마커 델타를 낸 fake라도 DB content에는 빈 문자열만 남는다', async () => {
    const result = await pool.query<{ content: string }>(
      'SELECT content FROM messages WHERE id = $1',
      [assistantMessageIdOf(gateEvents)],
    );

    expect(terminalEvent(gateEvents).eventType).toBe('answer.abstained');
    expect(result.rows).toEqual([{ content: '' }]);
  });

  it('기준 4: 생성 게이트 reason은 LLM 산문이 아니라 고정 문구다', () => {
    expect(reasonOf(gateEvents)).toBe(INSUFFICIENT_REASON);
    expect(reasonOf(gateEvents)).not.toContain(GATED_DELTAS[0]);
  });

  it('기준 5: 생성 게이트와 실제 검색 게이트의 reason 문구는 서로 다르다', () => {
    const generatedReason = reasonOf(gateEvents);
    const searchedReason = reasonOf(distanceGateEvents);

    expect(generatedReason).toBe(INSUFFICIENT_REASON);
    expect(searchedReason).toBe(BEYOND_CUTOFF_REASON);
    expect(generatedReason).not.toBe(searchedReason);
  });

  it('기준 6: 생성 게이트 기권 한 번이 insufficient_evidence 카운터를 정확히 1 올린다', () => {
    expect(terminalEvent(modelCauseEvents).eventType).toBe('answer.abstained');
    expect(insufficientAbstainMetricDelta).toBe(1);
  });

  it('기준 7: 생성 게이트 기권은 answer.delta를 하나도 보내지 않는다', () => {
    expect(terminalEvent(gateEvents).eventType).toBe('answer.abstained');
    expect(
      gateEvents.filter((event) => event.eventType === 'answer.delta'),
    ).toHaveLength(0);
  });

  it('기준 8: 인용 가능한 마커 델타가 있어도 message_citations는 0건이다', async () => {
    const result = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM message_citations WHERE message_id = $1',
      [assistantMessageIdOf(gateEvents)],
    );

    expect(terminalEvent(gateEvents).eventType).toBe('answer.abstained');
    expect(result.rows[0].count).toBe(0);
  });

  it('기준 9: 생성 게이트 기권은 검색된 근거를 retrieval.completed에 유지한다', () => {
    expect(terminalEvent(gateEvents).eventType).toBe('answer.abstained');
    expect(evidenceOf(gateEvents).length).toBeGreaterThan(0);
  });

  it('기준 10: 생성 게이트는 근거를 싣고 검색 게이트는 빈 근거를 싣는다', () => {
    expect(terminalEvent(gateEvents).eventType).toBe('answer.abstained');
    expect(evidenceOf(gateEvents).length).toBeGreaterThan(0);
    expect(terminalEvent(distanceGateEvents).eventType).toBe(
      'answer.abstained',
    );
    expect(evidenceOf(distanceGateEvents)).toEqual([]);
  });

  it('기준 11: 생성 게이트 기권에는 GenerationRun이 정확히 1건 기록된다', async () => {
    const result = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM generation_runs WHERE message_id = $1',
      [assistantMessageIdOf(gateEvents)],
    );

    expect(terminalEvent(gateEvents).eventType).toBe('answer.abstained');
    expect(result.rows[0].count).toBe(1);
  });

  it('기준 12: 생성 게이트 기권 run은 qa-v6 프롬프트를 기록한다', async () => {
    const result = await pool.query<{ prompt_version: string }>(
      'SELECT prompt_version FROM generation_runs WHERE message_id = $1',
      [assistantMessageIdOf(gateEvents)],
    );

    expect(terminalEvent(gateEvents).eventType).toBe('answer.abstained');
    expect(result.rows).toEqual([{ prompt_version: 'qa-v6' }]);
  });

  it('기준 13: 생성 게이트 기권 run은 실제 주입한 검색 정책 문자열을 기록한다', async () => {
    const result = await pool.query<{ retrieval_policy_version: string }>(
      'SELECT retrieval_policy_version FROM generation_runs WHERE message_id = $1',
      [assistantMessageIdOf(gateEvents)],
    );

    expect(terminalEvent(gateEvents).eventType).toBe('answer.abstained');
    expect(result.rows).toEqual([
      { retrieval_policy_version: GENERATED_POLICY_VERSION },
    ]);
  });

  it('기준 14: run 유무가 생성 게이트 기권과 검색 게이트 기권을 구분한다', async () => {
    const generated = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM generation_runs WHERE message_id = $1',
      [assistantMessageIdOf(gateEvents)],
    );
    const searched = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM generation_runs WHERE message_id = $1',
      [assistantMessageIdOf(distanceGateEvents)],
    );

    expect(terminalEvent(gateEvents).eventType).toBe('answer.abstained');
    expect(terminalEvent(distanceGateEvents).eventType).toBe(
      'answer.abstained',
    );
    expect(generated.rows[0].count).toBe(1);
    expect(searched.rows[0].count).toBe(0);
  });

  it('기준 15: 게이트가 켜져 있어도 verdict 미방출 스트림은 정상 완료한다', () => {
    expect(terminalEvent(gateEvents).eventType).toBe('answer.abstained');
    expect(terminalEvent(failOpenEvents).eventType).toBe('answer.completed');
    expect(
      failOpenEvents.filter((event) => event.eventType === 'answer.delta')
        .length,
    ).toBeGreaterThan(0);
  });

  it('기준 17: 게이트 off에서 정상 답변·거리 기권·점수 기권의 기존 동작을 모두 유지한다', () => {
    // 게이트 자체가 없는 스텁이 공허하게 통과하지 않도록 enabled 양성 대조를 둔다.
    expect(terminalEvent(gateEvents).eventType).toBe('answer.abstained');

    expect(terminalEvent(offNormalEvents).eventType).toBe('answer.completed');

    expect(terminalEvent(distanceGateEvents).eventType).toBe(
      'answer.abstained',
    );
    expect(evidenceOf(distanceGateEvents)).toEqual([]);
    expect(reasonOf(distanceGateEvents)).toBe(BEYOND_CUTOFF_REASON);

    expect(terminalEvent(scoreGateEvents).eventType).toBe('answer.abstained');
    expect(evidenceOf(scoreGateEvents)).toEqual([]);
    expect(reasonOf(scoreGateEvents)).toBe(BEYOND_CUTOFF_REASON);
    expect(lowScoreReranker.calls).toBeGreaterThan(0);
  });

  it('기준 19: 비어 있지 않은 missingAspects 발화는 model_verdict 원인을 1 올린다', () => {
    expect(terminalEvent(modelCauseEvents).eventType).toBe('answer.abstained');
    expect(modelCauseMetricDelta).toBe(1);
  });

  it('기준 20: 빈 missingAspects 발화도 기권하고 empty_aspects 원인을 1 올린다', () => {
    expect(terminalEvent(emptyCauseEvents).eventType).toBe('answer.abstained');
    expect(emptyCauseMetricDelta).toBe(1);
  });

  it('기준 21: model_verdict와 empty_aspects 기권은 같은 사용자 문구를 보낸다', () => {
    expect(reasonOf(modelCauseEvents)).toBe(INSUFFICIENT_REASON);
    expect(reasonOf(emptyCauseEvents)).toBe(INSUFFICIENT_REASON);
    expect(reasonOf(modelCauseEvents)).toBe(reasonOf(emptyCauseEvents));
  });

  it('기준 22: missingAspects 값은 어떤 SSE에도 없고 missingInformation은 빈 배열이다', () => {
    for (const event of modelCauseEvents) {
      expect(JSON.stringify(event)).not.toContain(INTERNAL_MISSING_ASPECT);
    }

    expect(terminalEvent(modelCauseEvents).eventType).toBe(
      'answer.abstained',
    );
    expect(abstainedOf(modelCauseEvents).missingInformation).toEqual([]);
  });

  it('기준 23: false verdict 뒤의 답변은 두 개 이상 증분 delta로 흐르고 정상 완료한다', () => {
    // true와 false를 함께 태워 verdict를 무시하는 스텁의 공허 통과를 막는다.
    expect(terminalEvent(gateEvents).eventType).toBe('answer.abstained');
    expect(
      gateEvents.filter((event) => event.eventType === 'answer.delta'),
    ).toHaveLength(0);

    expect(terminalEvent(incrementalEvents).eventType).toBe(
      'answer.completed',
    );
    expect(
      incrementalEvents.filter((event) => event.eventType === 'answer.delta')
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('기준 27: PATIENT_GUIDANCE 생성 게이트 기권에는 clinical_guidances 행이 생기지 않는다', () => {
    expect(terminalEvent(patientGateEvents).eventType).toBe(
      'answer.abstained',
    );
    expect(patientGuidanceCount).toBe(0);
  });

  it('기준 28: PATIENT_GUIDANCE 생성 게이트 기권에도 환자 스냅샷은 1건 남는다', () => {
    expect(terminalEvent(patientGateEvents).eventType).toBe(
      'answer.abstained',
    );
    expect(patientSnapshotDelta).toBe(1);
  });
});
