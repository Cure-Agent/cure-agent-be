// docs/specs/46 수용 기준 1~22 동결 테스트 — 구현 중 수정 금지
import { randomUUID } from 'node:crypto';
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
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { retrievalConfig } from '../src/global/config/retrieval.config';
import {
  LLM_PROVIDERS,
  type LlmAnswerChunk,
  type LlmAnswerVerdict,
  type LlmProvider,
  LlmProviderError,
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
const NONEXISTENT_GUIDELINE_ID = '01JNOSUCHGUIDELINEXXXXXXXX';
const LARGE_CUTOFF = 2;
const SMALL_CUTOFF = 0.000001;
const SCORE_CUTOFF = 6;
const RERANK_CANDIDATES = 30;
const NORMAL_PROVIDER_NAME = 'spec46-answer-provider';
const GATE_PROVIDER_NAME = 'spec46-gate-provider';

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
  vocabPrefilterEnabled: boolean;
  vocabCommonDfRatio: number;
}

interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

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

class FailingAnswerProvider implements LlmProvider {
  readonly name = 'spec46-failing-provider';
  readonly model = 'spec46-failing-model';

  // eslint-disable-next-line require-yield
  async *streamAnswer(
    _request: LlmStreamRequest,
  ): AsyncIterable<LlmAnswerChunk> {
    throw new LlmProviderError('spec 46 의도된 프로바이더 장애', {
      retryable: false,
    });
  }
}

class BlockingAfterFirstDeltaProvider implements LlmProvider {
  readonly name = 'spec46-abort-provider';
  readonly model = 'spec46-abort-model';
  readonly abortObserved: Promise<void>;
  private resolveAbort: () => void = () => undefined;

  constructor() {
    this.abortObserved = new Promise<void>((resolve) => {
      this.resolveAbort = resolve;
    });
  }

  async *streamAnswer(
    request: LlmStreamRequest,
  ): AsyncIterable<LlmAnswerChunk> {
    yield { kind: 'delta', text: '중단 전 첫 델타 [1].' };

    const signal = request.signal;
    if (!signal) {
      await new Promise<void>(() => undefined);
      return;
    }

    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        this.resolveAbort();
        resolve();
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

class RecordingReranker implements Reranker {
  readonly candidateBatches: RerankCandidate[][] = [];
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
    this.candidateBatches.push(
      candidates.map((candidate) => ({ ...candidate })),
    );
    return Promise.resolve({
      order: candidates.map((candidate) => candidate.chunkId),
      top1Relevance: this.relevance,
    });
  }
}

class ThrowingReranker implements Reranker {
  readonly model = 'spec46-throwing-reranker';
  calls = 0;

  rerank(
    _question: string,
    _candidates: RerankCandidate[],
  ): Promise<RerankResult> {
    this.calls += 1;
    return Promise.reject(new Error('spec 46 의도된 리랭커 장애'));
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

/** 열린 스트림에서 첫 delta까지 읽는다. 시간이나 chunk 경계는 계약으로 삼지 않는다. */
async function readThroughFirstDelta(reader: ByteReader): Promise<SseEvent[]> {
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let pending = '';

  while (true) {
    const { done, value } = await reader.read();
    if (value) pending += decoder.decode(value, { stream: !done });
    if (done) pending += decoder.decode();

    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      events.push(JSON.parse(line.slice('data: '.length)) as SseEvent);
    }

    if (events.some((event) => event.eventType === 'answer.delta')) {
      return events;
    }
    if (done) {
      if (pending.startsWith('data: ')) {
        events.push(
          JSON.parse(pending.slice('data: '.length)) as SseEvent,
        );
      }
      return events;
    }
  }
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

function eventOf(events: SseEvent[], eventType: string): SseEvent {
  const event = events.find((candidate) => candidate.eventType === eventType);
  if (!event) throw new Error(`${eventType} 이벤트가 없습니다.`);
  return event;
}

function progressEventOf(events: SseEvent[], stage: string): SseEvent {
  const event = events.find(
    (candidate) =>
      candidate.eventType === 'retrieval.progress' &&
      candidate.stage === stage,
  );
  if (!event) throw new Error(`retrieval.progress(${stage}) 이벤트가 없습니다.`);
  return event;
}

function eventsOf(events: SseEvent[], eventType: string): SseEvent[] {
  return events.filter((event) => event.eventType === eventType);
}

function progressStages(events: SseEvent[]): unknown[] {
  return eventsOf(events, 'retrieval.progress').map((event) => event.stage);
}

function terminalEvent(events: SseEvent[]): SseEvent {
  const terminal = events[events.length - 1];
  if (!terminal) throw new Error('종결 이벤트가 없습니다.');
  return terminal;
}

function assistantMessageIdOf(events: SseEvent[]): string {
  const value = eventOf(events, 'message.accepted').assistantMessageId;
  if (typeof value !== 'string') {
    throw new Error('message.accepted에 assistantMessageId가 없습니다.');
  }
  return value;
}

function expectExactKeys(event: SseEvent, keys: string[]): void {
  expect(Object.keys(event).sort()).toEqual([...keys].sort());
}

function hasOwn(event: SseEvent, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(event, key);
}

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

describe('spec 46: 답변 SSE 진행 단계 이벤트', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let happyApp: INestApplication;
  let rerankOffApp: INestApplication;
  let hybridOffApp: INestApplication;
  let rerankFailureApp: INestApplication;
  let distanceGateApp: INestApplication;
  let scoreGateApp: INestApplication;
  let generationGateApp: INestApplication;
  let providerFailureApp: INestApplication;
  let abortApp: INestApplication;

  let happyCookie: string;
  let rerankOffCookie: string;
  let hybridOffCookie: string;
  let rerankFailureCookie: string;
  let distanceGateCookie: string;
  let scoreGateCookie: string;
  let generationGateCookie: string;
  let providerFailureCookie: string;
  let abortCookie: string;

  let happyEvents: SseEvent[];
  let rerankOffEvents: SseEvent[];
  let hybridOffEvents: SseEvent[];
  let rerankFailureEvents: SseEvent[];
  let distanceGateEvents: SseEvent[];
  let scoreGateEvents: SseEvent[];
  let generationGateEvents: SseEvent[];
  let emptyEvidenceEvents: SseEvent[];
  let providerFailureEvents: SseEvent[];
  let metricProbeEvents: SseEvent[];
  let gateMetricProbeEvents: SseEvent[];
  let searchedCandidateCount = Number.NaN;
  let ttftProvider = '';
  let ttftCountDelta = Number.NaN;
  let gateTtftCountDelta = Number.NaN;
  let embedMetricDelta = Number.NaN;
  let vectorMetricDelta = Number.NaN;
  let keywordMetricDelta = Number.NaN;
  let rerankMetricDelta = Number.NaN;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalAnswerabilityGate =
    process.env.LLM_ANSWERABILITY_GATE_ENABLED;

  const normalProvider = new DeterministicAnswerProvider(
    NORMAL_PROVIDER_NAME,
    undefined,
    ['침 치료는 만성 요통의 통증 감소에 ', '도움이 됩니다 [1].'],
  );
  const gateProvider = new DeterministicAnswerProvider(
    GATE_PROVIDER_NAME,
    { insufficientEvidence: true, missingAspects: ['추가 임상 정보'] },
    ['이 델타는 생성 게이트 뒤 사용자에게 나가면 안 됩니다 [1].'],
  );
  const failingProvider = new FailingAnswerProvider();
  const abortProvider = new BlockingAfterFirstDeltaProvider();

  const happyReranker = new RecordingReranker(
    'spec46-happy-reranker',
    10,
  );
  const rerankOffReranker = new RecordingReranker(
    'spec46-disabled-reranker',
    10,
  );
  const hybridOffReranker = new RecordingReranker(
    'spec46-vector-reranker',
    10,
  );
  const throwingReranker = new ThrowingReranker();
  const distanceReranker = new RecordingReranker(
    'spec46-distance-reranker',
    10,
  );
  const scoreReranker = new RecordingReranker(
    'spec46-score-reranker',
    0,
  );
  const gateReranker = new RecordingReranker(
    'spec46-gate-reranker',
    10,
  );
  const failureReranker = new RecordingReranker(
    'spec46-provider-failure-reranker',
    10,
  );
  const abortReranker = new RecordingReranker(
    'spec46-abort-reranker',
    10,
  );

  const baseConfig: TestRetrievalConfig = {
    distanceCutoff: LARGE_CUTOFF,
    rerankEnabled: true,
    rerankCandidates: RERANK_CANDIDATES,
    rerankScoreCutoff: SCORE_CUTOFF,
    hybridEnabled: true,
    vocabPrefilterEnabled: true,
    vocabCommonDfRatio: 0.05,
  };

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
    gateEnabled = false,
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
  ): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ type: 'GUIDELINE_QA' })
      .expect(201);
    return response.body.data.id as string;
  };

  const ask = async (
    app: INestApplication,
    cookie: string,
    conversationId: string,
    extra: Record<string, unknown> = {},
  ): Promise<SseEvent[]> => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', cookie)
      .send({
        content: QUESTION,
        clientRequestId: randomUUID(),
        ...extra,
      })
      .expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    return parseSse(response.text);
  };

  const askInNewConversation = async (
    app: INestApplication,
    cookie: string,
    extra: Record<string, unknown> = {},
  ): Promise<SseEvent[]> => {
    const conversationId = await createConversation(app, cookie);
    return ask(app, cookie, conversationId, extra);
  };

  const waitForAssistantStatus = async (
    conversationId: string,
    expected: string,
  ): Promise<string> => {
    let status = '';
    // 비동기 disconnect 정리와 동기화할 뿐, 소요 시간 자체는 계약으로 단언하지 않는다.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await pool.query<{ status: string }>(
        "SELECT status FROM messages WHERE conversation_id = $1 AND role = 'ASSISTANT'",
        [conversationId],
      );
      status = result.rows[0]?.status ?? '';
      if (status === expected) return status;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return status;
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

    happyApp = await createApp(normalProvider, happyReranker, baseConfig);
    rerankOffApp = await createApp(normalProvider, rerankOffReranker, {
      ...baseConfig,
      rerankEnabled: false,
    });
    hybridOffApp = await createApp(normalProvider, hybridOffReranker, {
      ...baseConfig,
      hybridEnabled: false,
    });
    rerankFailureApp = await createApp(
      normalProvider,
      throwingReranker,
      baseConfig,
    );
    distanceGateApp = await createApp(normalProvider, distanceReranker, {
      ...baseConfig,
      distanceCutoff: SMALL_CUTOFF,
    });
    scoreGateApp = await createApp(normalProvider, scoreReranker, baseConfig);
    generationGateApp = await createApp(
      gateProvider,
      gateReranker,
      baseConfig,
      true,
    );
    providerFailureApp = await createApp(
      failingProvider,
      failureReranker,
      baseConfig,
    );
    abortApp = await createApp(abortProvider, abortReranker, baseConfig);

    await happyApp.get(GuidelineIngestService).ingest(yotongGuideline);

    happyCookie = (
      await socialSignUp(happyApp, {
        email: 'spec46-happy@clinic.kr',
        clinicName: '진행이벤트한의원',
        licenseNumber: 'LIC-4601',
      })
    ).cookie;
    rerankOffCookie = (
      await socialSignUp(rerankOffApp, {
        email: 'spec46-rerank-off@clinic.kr',
        clinicName: '리랭크꺼짐한의원',
        licenseNumber: 'LIC-4602',
      })
    ).cookie;
    hybridOffCookie = (
      await socialSignUp(hybridOffApp, {
        email: 'spec46-hybrid-off@clinic.kr',
        clinicName: '하이브리드꺼짐한의원',
        licenseNumber: 'LIC-4603',
      })
    ).cookie;
    rerankFailureCookie = (
      await socialSignUp(rerankFailureApp, {
        email: 'spec46-rerank-failure@clinic.kr',
        clinicName: '리랭크폴백한의원',
        licenseNumber: 'LIC-4604',
      })
    ).cookie;
    distanceGateCookie = (
      await socialSignUp(distanceGateApp, {
        email: 'spec46-distance@clinic.kr',
        clinicName: '거리컷한의원',
        licenseNumber: 'LIC-4605',
      })
    ).cookie;
    scoreGateCookie = (
      await socialSignUp(scoreGateApp, {
        email: 'spec46-score@clinic.kr',
        clinicName: '점수컷한의원',
        licenseNumber: 'LIC-4606',
      })
    ).cookie;
    generationGateCookie = (
      await socialSignUp(generationGateApp, {
        email: 'spec46-generation-gate@clinic.kr',
        clinicName: '생성게이트한의원',
        licenseNumber: 'LIC-4607',
      })
    ).cookie;
    providerFailureCookie = (
      await socialSignUp(providerFailureApp, {
        email: 'spec46-provider-failure@clinic.kr',
        clinicName: '프로바이더장애한의원',
        licenseNumber: 'LIC-4608',
      })
    ).cookie;
    abortCookie = (
      await socialSignUp(abortApp, {
        email: 'spec46-abort@clinic.kr',
        clinicName: '중단정리한의원',
        licenseNumber: 'LIC-4609',
      })
    ).cookie;

    const happyBatchesBefore = happyReranker.candidateBatches.length;
    happyEvents = await askInNewConversation(happyApp, happyCookie);
    const happyBatches = happyReranker.candidateBatches.slice(
      happyBatchesBefore,
    );
    if (happyBatches.length !== 1) {
      throw new Error('해피패스 요청의 리랭커 후보 배치를 하나로 식별하지 못했습니다.');
    }
    searchedCandidateCount = happyBatches[0].length;

    rerankOffEvents = await askInNewConversation(
      rerankOffApp,
      rerankOffCookie,
    );
    hybridOffEvents = await askInNewConversation(
      hybridOffApp,
      hybridOffCookie,
    );
    rerankFailureEvents = await askInNewConversation(
      rerankFailureApp,
      rerankFailureCookie,
    );
    distanceGateEvents = await askInNewConversation(
      distanceGateApp,
      distanceGateCookie,
    );
    scoreGateEvents = await askInNewConversation(
      scoreGateApp,
      scoreGateCookie,
    );
    generationGateEvents = await askInNewConversation(
      generationGateApp,
      generationGateCookie,
    );
    emptyEvidenceEvents = await askInNewConversation(happyApp, happyCookie, {
      filters: { guidelineIds: [NONEXISTENT_GUIDELINE_ID] },
    });
    providerFailureEvents = await askInNewConversation(
      providerFailureApp,
      providerFailureCookie,
    );

    const metricsBefore = await scrapeMetrics(happyApp);
    metricProbeEvents = await askInNewConversation(happyApp, happyCookie);
    const metricsAfter = await scrapeMetrics(happyApp);

    const providerResult = await pool.query<{ provider: string }>(
      'SELECT provider FROM generation_runs WHERE message_id = $1',
      [assistantMessageIdOf(metricProbeEvents)],
    );
    if (!providerResult.rows[0]?.provider) {
      throw new Error('TTFT 검증 요청의 실제 프로바이더를 찾지 못했습니다.');
    }
    ttftProvider = providerResult.rows[0].provider;
    ttftCountDelta =
      metricValue(
        metricsAfter,
        'llm_time_to_first_token_seconds_count',
        { provider: ttftProvider },
      ) -
      metricValue(
        metricsBefore,
        'llm_time_to_first_token_seconds_count',
        { provider: ttftProvider },
      );
    embedMetricDelta =
      metricValue(metricsAfter, 'rag_retrieval_duration_seconds_count', {
        stage: 'embed',
      }) -
      metricValue(metricsBefore, 'rag_retrieval_duration_seconds_count', {
        stage: 'embed',
      });
    vectorMetricDelta =
      metricValue(metricsAfter, 'rag_retrieval_duration_seconds_count', {
        stage: 'vector_search',
      }) -
      metricValue(metricsBefore, 'rag_retrieval_duration_seconds_count', {
        stage: 'vector_search',
      });
    keywordMetricDelta =
      metricValue(metricsAfter, 'rag_retrieval_duration_seconds_count', {
        stage: 'keyword_search',
      }) -
      metricValue(metricsBefore, 'rag_retrieval_duration_seconds_count', {
        stage: 'keyword_search',
      });
    rerankMetricDelta =
      metricValue(metricsAfter, 'rag_rerank_duration_seconds_count') -
      metricValue(metricsBefore, 'rag_rerank_duration_seconds_count');

    const gateMetricsBefore = await scrapeMetrics(generationGateApp);
    gateMetricProbeEvents = await askInNewConversation(
      generationGateApp,
      generationGateCookie,
    );
    const gateMetricsAfter = await scrapeMetrics(generationGateApp);
    gateTtftCountDelta =
      metricValue(
        gateMetricsAfter,
        'llm_time_to_first_token_seconds_count',
        { provider: GATE_PROVIDER_NAME },
      ) -
      metricValue(
        gateMetricsBefore,
        'llm_time_to_first_token_seconds_count',
        { provider: GATE_PROVIDER_NAME },
      );
  });

  afterAll(async () => {
    await abortApp?.close();
    await providerFailureApp?.close();
    await generationGateApp?.close();
    await scoreGateApp?.close();
    await distanceGateApp?.close();
    await rerankFailureApp?.close();
    await hybridOffApp?.close();
    await rerankOffApp?.close();
    await happyApp?.close();
    await pool?.end();
    await Promise.all([
      postgresContainer?.stop(),
      redisContainer?.stop(),
    ]);

    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('REDIS_URL', originalRedisUrl);
    restoreEnv('OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnv(
      'LLM_ANSWERABILITY_GATE_ENABLED',
      originalAnswerabilityGate,
    );
  });

  it('기준 1: 해피패스 진행 단계는 embedded → searched → reranked 순서로 각 1회 발신된다', () => {
    const progress = eventsOf(happyEvents, 'retrieval.progress');
    const stages = progress.map((event) => event.stage);

    expect(progress).toHaveLength(3);
    expect(stages).toEqual(['embedded', 'searched', 'reranked']);
    for (const stage of ['embedded', 'searched', 'reranked']) {
      expect(stages.filter((candidate) => candidate === stage)).toHaveLength(1);
    }
  });

  it('기준 2: 세 진행 이벤트는 retrieval.started 뒤이자 retrieval.completed 앞이다', () => {
    const startedIndex = happyEvents.findIndex(
      (event) => event.eventType === 'retrieval.started',
    );
    const completedIndex = happyEvents.findIndex(
      (event) => event.eventType === 'retrieval.completed',
    );
    const progressIndexes = happyEvents.flatMap((event, index) =>
      event.eventType === 'retrieval.progress' ? [index] : [],
    );

    expect(progressIndexes).toHaveLength(3);
    expect(
      progressIndexes.every((index) => index > startedIndex),
    ).toBe(true);
    expect(
      progressIndexes.every((index) => index < completedIndex),
    ).toBe(true);
  });

  it('기준 3: searched의 정수 candidates는 그 요청에서 검색되어 리랭커가 받은 후보 수다', () => {
    const searched = progressEventOf(happyEvents, 'searched');

    expectExactKeys(searched, ['eventType', 'stage', 'candidates']);
    expect(typeof searched.candidates).toBe('number');
    expect(Number.isInteger(searched.candidates)).toBe(true);
    expect(searchedCandidateCount).toBeGreaterThan(0);
    expect(searched.candidates).toBe(searchedCandidateCount);
  });

  it('기준 4: embedded와 reranked에는 candidates 키 자체가 없다', () => {
    const embedded = progressEventOf(happyEvents, 'embedded');
    const reranked = progressEventOf(happyEvents, 'reranked');

    expect(hasOwn(embedded, 'candidates')).toBe(false);
    expect(hasOwn(reranked, 'candidates')).toBe(false);
    expectExactKeys(embedded, ['eventType', 'stage']);
    expectExactKeys(reranked, ['eventType', 'stage']);
  });

  it('기준 5: 리랭크가 꺼지면 실제 두 단계만 오고 reranked는 오지 않는다', () => {
    const stages = progressStages(rerankOffEvents);

    expect(stages).toEqual(['embedded', 'searched']);
    expect(stages).not.toContain('reranked');
  });

  it('기준 6: 리랭크가 꺼져도 embedded와 searched는 각각 발신된다', () => {
    const stages = progressStages(rerankOffEvents);

    expect(stages.filter((stage) => stage === 'embedded')).toHaveLength(1);
    expect(stages.filter((stage) => stage === 'searched')).toHaveLength(1);
  });

  it('기준 7: 리랭커가 던져 순위 폴백해도 reranked가 오고 정상 답변으로 끝난다', () => {
    expect(throwingReranker.calls).toBeGreaterThan(0);
    expect(progressStages(rerankFailureEvents)).toEqual([
      'embedded',
      'searched',
      'reranked',
    ]);
    expect(terminalEvent(rerankFailureEvents).eventType).toBe(
      'answer.completed',
    );
  });

  it('기준 8: 하이브리드가 꺼져도 embedded와 searched가 각각 발신된다', () => {
    const stages = progressStages(hybridOffEvents);

    expect(stages.filter((stage) => stage === 'embedded')).toHaveLength(1);
    expect(stages.filter((stage) => stage === 'searched')).toHaveLength(1);
    expect(terminalEvent(hybridOffEvents).eventType).toBe('answer.completed');
  });

  it('기준 9: answer.started는 retrieval.completed 뒤이자 첫 answer.delta 앞이다', () => {
    const completedIndex = happyEvents.findIndex(
      (event) => event.eventType === 'retrieval.completed',
    );
    const startedIndexes = happyEvents.flatMap((event, index) =>
      event.eventType === 'answer.started' ? [index] : [],
    );
    const firstDeltaIndex = happyEvents.findIndex(
      (event) => event.eventType === 'answer.delta',
    );

    expect(startedIndexes).toHaveLength(1);
    expect(startedIndexes[0]).toBeGreaterThan(completedIndex);
    expect(startedIndexes[0]).toBeLessThan(firstDeltaIndex);
  });

  it('기준 10: answer.started에는 evidence가 없고 eventType 키 하나만 있다', () => {
    const started = eventOf(happyEvents, 'answer.started');

    expect(hasOwn(started, 'evidence')).toBe(false);
    expectExactKeys(started, ['eventType']);
  });

  it('기준 11: 생성 게이트 기권도 LLM 호출 전 answer.started를 이미 발신한다', () => {
    const startedIndex = generationGateEvents.findIndex(
      (event) => event.eventType === 'answer.started',
    );
    const abstainedIndex = generationGateEvents.findIndex(
      (event) => event.eventType === 'answer.abstained',
    );

    expect(startedIndex).toBeGreaterThan(-1);
    expect(startedIndex).toBeLessThan(abstainedIndex);
    expect(eventsOf(generationGateEvents, 'answer.delta')).toHaveLength(0);
    expect(terminalEvent(generationGateEvents).eventType).toBe(
      'answer.abstained',
    );
  });

  it('기준 12: 근거 0건 기권은 검색까지 진행하지만 answer.started를 발신하지 않는다', () => {
    expect(progressStages(emptyEvidenceEvents)).toEqual([
      'embedded',
      'searched',
    ]);
    expect(eventsOf(emptyEvidenceEvents, 'answer.started')).toHaveLength(0);
    expect(terminalEvent(emptyEvidenceEvents).eventType).toBe(
      'answer.abstained',
    );
  });

  it('기준 13: 거리 컷 기권은 검색까지만 말하고 reranked를 발신하지 않는다', () => {
    expect(progressStages(distanceGateEvents)).toEqual([
      'embedded',
      'searched',
    ]);
    expect(eventsOf(distanceGateEvents, 'answer.started')).toHaveLength(0);
    expect(terminalEvent(distanceGateEvents).eventType).toBe(
      'answer.abstained',
    );
  });

  it('기준 14: 점수 컷 기권은 reranked까지 말하고 answer.started는 발신하지 않는다', () => {
    expect(progressStages(scoreGateEvents)).toEqual([
      'embedded',
      'searched',
      'reranked',
    ]);
    expect(eventsOf(scoreGateEvents, 'answer.started')).toHaveLength(0);
    expect(terminalEvent(scoreGateEvents).eventType).toBe('answer.abstained');
  });

  it('기준 15: 기권의 retrieval.completed와 answer.abstained 필드는 기존 계약 그대로다', () => {
    const retrievalCompleted = eventOf(
      scoreGateEvents,
      'retrieval.completed',
    );
    const abstained = eventOf(scoreGateEvents, 'answer.abstained');

    // 회귀 단언만으로 스텁이 통과하지 않도록 신규 reranked 계약도 같은 경로에서 묶는다.
    expect(progressStages(scoreGateEvents)).toEqual([
      'embedded',
      'searched',
      'reranked',
    ]);
    expectExactKeys(retrievalCompleted, ['eventType', 'evidence']);
    expect(retrievalCompleted.evidence).toEqual([]);
    expectExactKeys(abstained, [
      'eventType',
      'message',
      'reason',
      'missingInformation',
    ]);
  });

  it('기준 16: 신규 이벤트가 끼어도 기존 일곱 이벤트의 키 집합은 하나도 바뀌지 않는다', () => {
    expect(progressStages(happyEvents)).toEqual([
      'embedded',
      'searched',
      'reranked',
    ]);
    expectExactKeys(eventOf(happyEvents, 'answer.started'), ['eventType']);

    expectExactKeys(eventOf(happyEvents, 'message.accepted'), [
      'eventType',
      'requestId',
      'userMessageId',
      'assistantMessageId',
    ]);
    expectExactKeys(eventOf(happyEvents, 'retrieval.started'), [
      'eventType',
      'requestId',
    ]);
    expectExactKeys(eventOf(happyEvents, 'retrieval.completed'), [
      'eventType',
      'evidence',
    ]);
    for (const delta of eventsOf(happyEvents, 'answer.delta')) {
      expectExactKeys(delta, ['eventType', 'messageId', 'seq', 'delta']);
    }
    expectExactKeys(eventOf(happyEvents, 'answer.completed'), [
      'eventType',
      'message',
    ]);
    expectExactKeys(eventOf(scoreGateEvents, 'answer.abstained'), [
      'eventType',
      'message',
      'reason',
      'missingInformation',
    ]);
    expectExactKeys(eventOf(providerFailureEvents, 'error'), [
      'eventType',
      'code',
      'message',
      'retryable',
      'traceId',
    ]);
  });

  it('기준 17: 진행 이벤트가 끼어도 answer.delta seq는 0부터 연속이다', () => {
    const deltas = eventsOf(happyEvents, 'answer.delta');

    expect(progressStages(happyEvents)).toEqual([
      'embedded',
      'searched',
      'reranked',
    ]);
    expect(eventOf(happyEvents, 'answer.started')).toBeDefined();
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.map((delta) => delta.seq)).toEqual(
      deltas.map((_, index) => index),
    );
  });

  it('기준 18: 스트림 실패는 answer.started 뒤 error를 보내고 메시지를 FAILED로 저장한다', async () => {
    const answerStartedIndex = providerFailureEvents.findIndex(
      (event) => event.eventType === 'answer.started',
    );
    const errorIndex = providerFailureEvents.findIndex(
      (event) => event.eventType === 'error',
    );
    const error = eventOf(providerFailureEvents, 'error');

    expect(answerStartedIndex).toBeGreaterThan(-1);
    expect(answerStartedIndex).toBeLessThan(errorIndex);
    expectExactKeys(error, [
      'eventType',
      'code',
      'message',
      'retryable',
      'traceId',
    ]);
    expect(error).toMatchObject({
      code: 'LLM_UNAVAILABLE',
      message: expect.any(String),
      retryable: true,
      traceId: expect.any(String),
    });

    const result = await pool.query<{ status: string }>(
      'SELECT status FROM messages WHERE id = $1',
      [assistantMessageIdOf(providerFailureEvents)],
    );
    expect(result.rows).toEqual([{ status: 'FAILED' }]);
  });

  it('기준 19: 클라이언트 abort 전 answer.started가 보이고 메시지는 CANCELLED로 정리된다', async () => {
    const conversationId = await createConversation(abortApp, abortCookie);
    const controller = new AbortController();
    const response = await fetch(
      `${await abortApp.getUrl()}/api/v1/conversations/${conversationId}/messages/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Protection': '1',
          Cookie: abortCookie,
        },
        body: JSON.stringify({
          content: QUESTION,
          clientRequestId: randomUUID(),
        }),
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(
      'text/event-stream',
    );

    const reader = response.body?.getReader();
    if (!reader) throw new Error('abort 검증 스트림의 reader가 없습니다.');

    let observed: SseEvent[] = [];
    try {
      observed = await readThroughFirstDelta(reader);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }

    await abortProvider.abortObserved;
    const status = await waitForAssistantStatus(conversationId, 'CANCELLED');
    const startedIndex = observed.findIndex(
      (event) => event.eventType === 'answer.started',
    );
    const deltaIndex = observed.findIndex(
      (event) => event.eventType === 'answer.delta',
    );

    expect(eventOf(observed, 'message.accepted')).toBeDefined();
    expect(startedIndex).toBeGreaterThan(-1);
    expect(deltaIndex).toBeGreaterThan(-1);
    expect(startedIndex).toBeLessThan(deltaIndex);
    expect(status).toBe('CANCELLED');
  });

  it('기준 20: 첫 answer.delta 요청은 실제 provider 라벨의 TTFT count를 정확히 1 올린다', () => {
    expect(terminalEvent(metricProbeEvents).eventType).toBe(
      'answer.completed',
    );
    expect(eventOf(metricProbeEvents, 'answer.started')).toBeDefined();
    expect(eventsOf(metricProbeEvents, 'answer.delta').length).toBeGreaterThan(
      0,
    );
    expect(ttftProvider).toBe(NORMAL_PROVIDER_NAME);
    expect(ttftCountDelta).toBe(1);
  });

  it('기준 21: verdict만 받고 델타 없이 기권하면 TTFT를 관측하지 않는다', () => {
    expect(terminalEvent(gateMetricProbeEvents).eventType).toBe(
      'answer.abstained',
    );
    expect(eventOf(gateMetricProbeEvents, 'answer.started')).toBeDefined();
    expect(eventsOf(gateMetricProbeEvents, 'answer.delta')).toHaveLength(0);
    expect(gateTtftCountDelta).toBe(0);
  });

  it('기준 22: 진행 이벤트와 함께 기존 embed·vector·keyword·rerank 지연도 계속 관측된다', () => {
    // 기존 메트릭 회귀만으로 스텁이 통과하지 않도록 같은 요청의 신규 이벤트도 단언한다.
    expect(progressStages(metricProbeEvents)).toEqual([
      'embedded',
      'searched',
      'reranked',
    ]);
    expect(eventOf(metricProbeEvents, 'answer.started')).toBeDefined();
    expect(embedMetricDelta).toBe(1);
    expect(vectorMetricDelta).toBe(1);
    expect(keywordMetricDelta).toBe(1);
    expect(rerankMetricDelta).toBe(1);
  });
});
