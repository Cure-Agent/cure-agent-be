// docs/specs/47 수용 기준 1~20 동결 테스트 — 구현 중 수정 금지
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
import {
  TRANSLATOR,
  type SupportedLang,
  type Translator,
} from '../src/infrastructure/llm/translation/translator.port';
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
const NORMAL_PROVIDER_NAME = 'spec47-answer-provider';
const GATE_PROVIDER_NAME = 'spec47-gate-provider';
const TRANSLATION_MODEL = 'spec47-fixture-translator-v1';
const TRANSLATED_EXCERPT = [
  'This is synthetic translated evidence for the stream frame contract.',
  'It is unrelated to any real patient or external guideline provider.',
].join(' ');

const EVIDENCE_REQUIRED_KEYS = [
  'id',
  'guidelineId',
  'guidelineVersionId',
  'guidelineTitle',
  'version',
  'sectionPath',
  'excerpt',
  'sourceUrl',
] as const;

const EVIDENCE_ALLOWED_KEYS = new Set([
  ...EVIDENCE_REQUIRED_KEYS,
  'recommendationNumber',
  'recommendationText',
  'recommendationGrade',
  'evidenceLevel',
  'pageStart',
  'pageEnd',
  'excerptTranslated',
  'titleTranslated',
  'recommendationTextTranslated',
  'sectionPathTranslated',
  'translationModel',
]);

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
  keywordCandidateBudget: number;
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
  readonly name = 'spec47-failing-provider';
  readonly model = 'spec47-failing-model';

  // eslint-disable-next-line require-yield
  async *streamAnswer(
    _request: LlmStreamRequest,
  ): AsyncIterable<LlmAnswerChunk> {
    throw new LlmProviderError('spec 47 의도된 프로바이더 장애', {
      retryable: false,
    });
  }
}

class BlockingAfterFirstDeltaProvider implements LlmProvider {
  readonly name = 'spec47-abort-provider';
  readonly model = 'spec47-abort-model';
  readonly abortObserved: Promise<void>;
  private resolveAbort: () => void = () => undefined;

  constructor() {
    this.abortObserved = new Promise<void>((resolve) => {
      this.resolveAbort = resolve;
    });
  }

  async *streamAnswer(
    streamRequest: LlmStreamRequest,
  ): AsyncIterable<LlmAnswerChunk> {
    yield { kind: 'delta', text: '중단 전 첫 델타 [1].' };

    const signal = streamRequest.signal;
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

    signal.throwIfAborted();
  }
}

class ReversingRecordingReranker implements Reranker {
  readonly candidateBatches: RerankCandidate[][] = [];
  readonly returnedOrders: string[][] = [];
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
    const order = candidates
      .map((candidate) => candidate.chunkId)
      .reverse();
    this.returnedOrders.push([...order]);
    return Promise.resolve({ order, top1Relevance: this.relevance });
  }
}

class DeterministicTranslator implements Translator {
  readonly model = TRANSLATION_MODEL;

  translate(text: string, target: SupportedLang): Promise<string> {
    return Promise.resolve(target === 'ko' ? QUESTION : `[en] ${text}`);
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

/** 열린 스트림에서 첫 delta까지 읽는다. 시간이나 TCP chunk는 계약으로 삼지 않는다. */
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

function eventsOf(events: SseEvent[], eventType: string): SseEvent[] {
  return events.filter((event) => event.eventType === eventType);
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

function expectExactKeys(event: Record<string, unknown>, keys: string[]): void {
  expect(Object.keys(event).sort()).toEqual([...keys].sort());
}

function hasOwn(event: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(event, key);
}

function recordOf(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} 객체가 없습니다.`);
  }
  return value as Record<string, unknown>;
}

function evidenceRecordOf(frame: SseEvent): Record<string, unknown> {
  return recordOf(frame.evidence, 'retrieval.evidence.evidence');
}

function evidenceIdOf(frame: SseEvent): string {
  const id = evidenceRecordOf(frame).id;
  if (typeof id !== 'string') {
    throw new Error('retrieval.evidence.evidence.id가 문자열이 아닙니다.');
  }
  return id;
}

function expectAnswerStartedContract(
  events: SseEvent[],
  expectedEvidenceCount: number,
): SseEvent {
  const startedEvents = eventsOf(events, 'answer.started');
  expect(startedEvents).toHaveLength(1);
  const started = eventOf(events, 'answer.started');
  expect(hasOwn(started, 'evidence')).toBe(false);
  expectExactKeys(started, ['eventType', 'evidenceCount']);
  expect(typeof started.evidenceCount).toBe('number');
  expect(Number.isInteger(started.evidenceCount)).toBe(true);
  expect(started.evidenceCount).toBe(expectedEvidenceCount);
  return started;
}

function expectEvidenceFrameContract(frame: SseEvent): void {
  expectExactKeys(frame, ['eventType', 'index', 'total', 'evidence']);
  expect(frame.eventType).toBe('retrieval.evidence');
  expect(typeof frame.index).toBe('number');
  expect(Number.isInteger(frame.index)).toBe(true);
  expect(typeof frame.total).toBe('number');
  expect(Number.isInteger(frame.total)).toBe(true);
  expect(recordOf(frame.evidence, 'retrieval.evidence.evidence')).toBeDefined();
}

function expectRetrievalCompletedContract(events: SseEvent[]): SseEvent {
  const completedEvents = eventsOf(events, 'retrieval.completed');
  expect(completedEvents).toHaveLength(1);
  const completed = eventOf(events, 'retrieval.completed');
  expect(hasOwn(completed, 'evidence')).toBe(false);
  expectExactKeys(completed, ['eventType']);
  return completed;
}

function expectEvidenceIndexContract(frames: SseEvent[]): void {
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.map((frame) => frame.index)).toEqual(
    frames.map((_, index) => index),
  );
  expect(new Set(frames.map((frame) => frame.total))).toEqual(
    new Set([frames.length]),
  );
}

function expectAllEvidenceBetweenStartedAndCompleted(
  events: SseEvent[],
): void {
  const startedIndex = events.findIndex(
    (event) => event.eventType === 'answer.started',
  );
  const completedIndex = events.findIndex(
    (event) => event.eventType === 'retrieval.completed',
  );
  const evidenceIndexes = events.flatMap((event, index) =>
    event.eventType === 'retrieval.evidence' ? [index] : [],
  );

  expect(startedIndex).toBeGreaterThan(-1);
  expect(completedIndex).toBeGreaterThan(-1);
  expect(evidenceIndexes.length).toBeGreaterThan(0);
  expect(evidenceIndexes.every((index) => index > startedIndex)).toBe(true);
  expect(evidenceIndexes.every((index) => index < completedIndex)).toBe(true);
}

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

describe('spec 47: 근거 프레임 도착 순서 계약', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let happyApp: INestApplication;
  let rerankOffApp: INestApplication;
  let distanceGateApp: INestApplication;
  let scoreGateApp: INestApplication;
  let generationGateApp: INestApplication;
  let providerFailureApp: INestApplication;
  let abortApp: INestApplication;
  let englishApp: INestApplication;

  let happyCookie: string;
  let rerankOffCookie: string;
  let distanceGateCookie: string;
  let scoreGateCookie: string;
  let generationGateCookie: string;
  let providerFailureCookie: string;
  let abortCookie: string;
  let englishCookie: string;

  let happyEvents: SseEvent[];
  let rerankOffEvents: SseEvent[];
  let distanceGateEvents: SseEvent[];
  let scoreGateEvents: SseEvent[];
  let generationGateEvents: SseEvent[];
  let emptyEvidenceEvents: SseEvent[];
  let providerFailureEvents: SseEvent[];
  let englishEvents: SseEvent[];
  let metricProbeEvents: SseEvent[];
  let gateMetricProbeEvents: SseEvent[];

  let happyCandidateOrder: string[] = [];
  let happyExpectedOrder: string[] = [];
  let generationExpectedOrder: string[] = [];
  let failureExpectedOrder: string[] = [];
  let englishExpectedOrder: string[] = [];
  let translatedChunkId = '';
  let happyEvidenceOracles = new Map<string, Record<string, unknown>>();
  let englishEvidenceOracle: Record<string, unknown> = {};
  let ttftProvider = '';
  let ttftCountDelta = Number.NaN;
  let gateTtftCountDelta = Number.NaN;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalAnswerabilityGate =
    process.env.LLM_ANSWERABILITY_GATE_ENABLED;

  const translator = new DeterministicTranslator();
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

  const happyReranker = new ReversingRecordingReranker(
    'spec47-happy-reranker',
    10,
  );
  const rerankOffReranker = new ReversingRecordingReranker(
    'spec47-disabled-reranker',
    10,
  );
  const distanceReranker = new ReversingRecordingReranker(
    'spec47-distance-reranker',
    10,
  );
  const scoreReranker = new ReversingRecordingReranker(
    'spec47-score-reranker',
    0,
  );
  const generationReranker = new ReversingRecordingReranker(
    'spec47-generation-reranker',
    10,
  );
  const failureReranker = new ReversingRecordingReranker(
    'spec47-provider-failure-reranker',
    10,
  );
  const abortReranker = new ReversingRecordingReranker(
    'spec47-abort-reranker',
    10,
  );
  const englishReranker = new ReversingRecordingReranker(
    'spec47-english-reranker',
    10,
  );

  const baseConfig: TestRetrievalConfig = {
    distanceCutoff: LARGE_CUTOFF,
    rerankEnabled: true,
    rerankCandidates: RERANK_CANDIDATES,
    rerankScoreCutoff: SCORE_CUTOFF,
    hybridEnabled: true,
    vocabPrefilterEnabled: true,
    keywordCandidateBudget: 75,
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
        .overrideProvider(TRANSLATOR)
        .useValue(translator)
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
    const id = response.body.data.id;
    if (typeof id !== 'string') throw new Error('대화 id가 문자열이 아닙니다.');
    return id;
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

  const getEvidence = async (
    app: INestApplication,
    cookie: string,
    evidenceId: string,
    lang?: SupportedLang,
  ): Promise<Record<string, unknown>> => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/evidence/${evidenceId}`)
      .query(lang ? { lang } : {})
      .set('Cookie', cookie)
      .expect(200);
    return recordOf(response.body.data, 'GET evidence 응답 data');
  };

  const captureRerankOrder = async (
    reranker: ReversingRecordingReranker,
    work: () => Promise<SseEvent[]>,
  ): Promise<{ events: SseEvent[]; candidates: string[]; order: string[] }> => {
    const batchStart = reranker.candidateBatches.length;
    const orderStart = reranker.returnedOrders.length;
    const events = await work();
    const batches = reranker.candidateBatches.slice(batchStart);
    const orders = reranker.returnedOrders.slice(orderStart);
    if (batches.length !== 1 || orders.length !== 1) {
      throw new Error('요청의 리랭커 후보 배치와 반환 순위를 하나로 식별하지 못했습니다.');
    }
    return {
      events,
      candidates: batches[0].map((candidate) => candidate.chunkId),
      order: [...orders[0]],
    };
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
    distanceGateApp = await createApp(normalProvider, distanceReranker, {
      ...baseConfig,
      distanceCutoff: SMALL_CUTOFF,
    });
    scoreGateApp = await createApp(normalProvider, scoreReranker, baseConfig);
    generationGateApp = await createApp(
      gateProvider,
      generationReranker,
      baseConfig,
      true,
    );
    providerFailureApp = await createApp(
      failingProvider,
      failureReranker,
      baseConfig,
    );
    abortApp = await createApp(abortProvider, abortReranker, baseConfig);
    englishApp = await createApp(normalProvider, englishReranker, baseConfig);

    await happyApp.get(GuidelineIngestService).ingest(yotongGuideline);

    happyCookie = (
      await socialSignUp(happyApp, {
        email: 'spec47-happy@clinic.kr',
        clinicName: '프레임도착한의원',
        licenseNumber: 'LIC-4701',
      })
    ).cookie;
    rerankOffCookie = (
      await socialSignUp(rerankOffApp, {
        email: 'spec47-rerank-off@clinic.kr',
        clinicName: '프레임리랭크꺼짐한의원',
        licenseNumber: 'LIC-4702',
      })
    ).cookie;
    distanceGateCookie = (
      await socialSignUp(distanceGateApp, {
        email: 'spec47-distance@clinic.kr',
        clinicName: '프레임거리컷한의원',
        licenseNumber: 'LIC-4703',
      })
    ).cookie;
    scoreGateCookie = (
      await socialSignUp(scoreGateApp, {
        email: 'spec47-score@clinic.kr',
        clinicName: '프레임점수컷한의원',
        licenseNumber: 'LIC-4704',
      })
    ).cookie;
    generationGateCookie = (
      await socialSignUp(generationGateApp, {
        email: 'spec47-generation-gate@clinic.kr',
        clinicName: '프레임생성게이트한의원',
        licenseNumber: 'LIC-4705',
      })
    ).cookie;
    providerFailureCookie = (
      await socialSignUp(providerFailureApp, {
        email: 'spec47-provider-failure@clinic.kr',
        clinicName: '프레임프로바이더장애한의원',
        licenseNumber: 'LIC-4706',
      })
    ).cookie;
    abortCookie = (
      await socialSignUp(abortApp, {
        email: 'spec47-abort@clinic.kr',
        clinicName: '프레임중단정리한의원',
        licenseNumber: 'LIC-4707',
      })
    ).cookie;
    englishCookie = (
      await socialSignUp(englishApp, {
        email: 'spec47-english@clinic.kr',
        clinicName: '프레임영문한의원',
        licenseNumber: 'LIC-4708',
      })
    ).cookie;

    const happyTrace = await captureRerankOrder(
      happyReranker,
      () => askInNewConversation(happyApp, happyCookie),
    );
    happyEvents = happyTrace.events;
    happyCandidateOrder = happyTrace.candidates;
    happyExpectedOrder = happyTrace.order;

    rerankOffEvents = await askInNewConversation(
      rerankOffApp,
      rerankOffCookie,
    );
    distanceGateEvents = await askInNewConversation(
      distanceGateApp,
      distanceGateCookie,
    );
    scoreGateEvents = await askInNewConversation(
      scoreGateApp,
      scoreGateCookie,
    );

    const generationTrace = await captureRerankOrder(
      generationReranker,
      () => askInNewConversation(generationGateApp, generationGateCookie),
    );
    generationGateEvents = generationTrace.events;
    generationExpectedOrder = generationTrace.order;

    emptyEvidenceEvents = await askInNewConversation(happyApp, happyCookie, {
      filters: { guidelineIds: [NONEXISTENT_GUIDELINE_ID] },
    });

    const failureTrace = await captureRerankOrder(
      failureReranker,
      () => askInNewConversation(providerFailureApp, providerFailureCookie),
    );
    providerFailureEvents = failureTrace.events;
    failureExpectedOrder = failureTrace.order;

    if (happyExpectedOrder.length < 2) {
      throw new Error('해피패스의 최종 근거가 2건 미만이라 개수·순서 계약을 검증할 수 없습니다.');
    }
    translatedChunkId = happyExpectedOrder[0];

    const source = await pool.query<{ content_hash: string }>(
      'SELECT content_hash FROM evidence_chunks WHERE id = $1',
      [translatedChunkId],
    );
    if (!source.rows[0]?.content_hash) {
      throw new Error('영문 근거 fixture의 원문 content_hash를 찾지 못했습니다.');
    }
    await pool.query(
      `INSERT INTO evidence_chunk_translations
         (id, chunk_id, lang, content, source_content_hash, translator_model)
       VALUES ($1, $2, 'en', $3, $4, $5)`,
      [
        'spec47-translation-en',
        translatedChunkId,
        TRANSLATED_EXCERPT,
        source.rows[0].content_hash,
        TRANSLATION_MODEL,
      ],
    );

    happyEvidenceOracles = new Map(
      await Promise.all(
        happyExpectedOrder.map(async (evidenceId) => [
          evidenceId,
          await getEvidence(happyApp, happyCookie, evidenceId),
        ] as const),
      ),
    );

    const englishTrace = await captureRerankOrder(
      englishReranker,
      () =>
        askInNewConversation(englishApp, englishCookie, {
          responseLang: 'en',
        }),
    );
    englishEvents = englishTrace.events;
    englishExpectedOrder = englishTrace.order;
    englishEvidenceOracle = await getEvidence(
      englishApp,
      englishCookie,
      translatedChunkId,
      'en',
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
    await englishApp?.close();
    await abortApp?.close();
    await providerFailureApp?.close();
    await generationGateApp?.close();
    await scoreGateApp?.close();
    await distanceGateApp?.close();
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

  it('기준 1: 해피패스의 answer.started는 reranked 뒤·retrieval.completed 앞에 정확히 1회 발신된다', () => {
    const rerankedIndex = happyEvents.findIndex(
      (event) =>
        event.eventType === 'retrieval.progress' &&
        event.stage === 'reranked',
    );
    const startedIndexes = happyEvents.flatMap((event, index) =>
      event.eventType === 'answer.started' ? [index] : [],
    );
    const completedIndex = happyEvents.findIndex(
      (event) => event.eventType === 'retrieval.completed',
    );

    expect(rerankedIndex).toBeGreaterThan(-1);
    expect(completedIndex).toBeGreaterThan(-1);
    expect(startedIndexes).toHaveLength(1);
    expect(startedIndexes[0]).toBeGreaterThan(rerankedIndex);
    expect(startedIndexes[0]).toBeLessThan(completedIndex);
  });

  it('기준 2: answer.started의 정수 evidenceCount는 관측된 최종 근거 수와 일치한다', () => {
    const frames = eventsOf(happyEvents, 'retrieval.evidence');
    const started = eventOf(happyEvents, 'answer.started');

    expect(happyExpectedOrder.length).toBeGreaterThanOrEqual(2);
    expect(frames).toHaveLength(happyExpectedOrder.length);
    expect(typeof started.evidenceCount).toBe('number');
    expect(Number.isInteger(started.evidenceCount)).toBe(true);
    expect(started.evidenceCount).toBe(frames.length);
  });

  it('기준 3: answer.started에는 evidence 키가 없고 키 집합은 eventType·evidenceCount뿐이다', () => {
    const started = eventOf(happyEvents, 'answer.started');

    expect(hasOwn(started, 'evidence')).toBe(false);
    expectExactKeys(started, ['eventType', 'evidenceCount']);
  });

  it('기준 4: 검색 게이트의 근거 0건·거리 컷·점수 컷은 모두 answer.started를 발신하지 않는다', () => {
    const searchGatePaths = [
      { name: '근거 0건', events: emptyEvidenceEvents },
      { name: '거리 컷', events: distanceGateEvents },
      { name: '점수 컷', events: scoreGateEvents },
    ];

    expect(progressStages(emptyEvidenceEvents)).toEqual([
      'embedded',
      'searched',
    ]);
    expect(progressStages(distanceGateEvents)).toEqual([
      'embedded',
      'searched',
    ]);
    expect(distanceReranker.calls).toBe(0);
    expect(progressStages(scoreGateEvents)).toEqual([
      'embedded',
      'searched',
      'reranked',
    ]);
    expect(scoreReranker.calls).toBeGreaterThan(0);

    for (const path of searchGatePaths) {
      expect({
        path: path.name,
        startedCount: eventsOf(path.events, 'answer.started').length,
      }).toEqual({ path: path.name, startedCount: 0 });
      expect(terminalEvent(path.events).eventType).toBe('answer.abstained');
      expectRetrievalCompletedContract(path.events);
    }
  });

  it('기준 5: 생성 게이트 기권은 answer.started 뒤 answer.abstained가 오고 delta는 없다', () => {
    const startedIndex = generationGateEvents.findIndex(
      (event) => event.eventType === 'answer.started',
    );
    const abstainedIndex = generationGateEvents.findIndex(
      (event) => event.eventType === 'answer.abstained',
    );
    const frames = eventsOf(generationGateEvents, 'retrieval.evidence');

    expect(generationExpectedOrder.length).toBeGreaterThanOrEqual(2);
    expectAnswerStartedContract(
      generationGateEvents,
      generationExpectedOrder.length,
    );
    expect(startedIndex).toBeGreaterThan(-1);
    expect(abstainedIndex).toBeGreaterThan(-1);
    expect(startedIndex).toBeLessThan(abstainedIndex);
    expect(frames).toHaveLength(generationExpectedOrder.length);
    expect(eventsOf(generationGateEvents, 'answer.delta')).toHaveLength(0);
    expect(terminalEvent(generationGateEvents).eventType).toBe(
      'answer.abstained',
    );
  });

  it('기준 6: 리랭크가 꺼져도 answer.started가 retrieval.completed 앞에 오고 reranked는 없다', () => {
    const startedIndex = rerankOffEvents.findIndex(
      (event) => event.eventType === 'answer.started',
    );
    const completedIndex = rerankOffEvents.findIndex(
      (event) => event.eventType === 'retrieval.completed',
    );
    const frames = eventsOf(rerankOffEvents, 'retrieval.evidence');

    expect(startedIndex).toBeGreaterThan(-1);
    expect(completedIndex).toBeGreaterThan(-1);
    expect(startedIndex).toBeLessThan(completedIndex);
    expect(progressStages(rerankOffEvents)).toEqual(['embedded', 'searched']);
    expect(progressStages(rerankOffEvents)).not.toContain('reranked');
    expectAnswerStartedContract(rerankOffEvents, frames.length);
  });

  it('기준 7: retrieval.evidence는 리랭커가 확정한 최종 근거 1건마다 1개 발신된다', () => {
    const frames = eventsOf(happyEvents, 'retrieval.evidence');

    expect(happyExpectedOrder.length).toBeGreaterThanOrEqual(2);
    expect(frames).toHaveLength(happyExpectedOrder.length);
    for (const frame of frames) expectEvidenceFrameContract(frame);
  });

  it('기준 8: retrieval.evidence의 index는 0부터 연속이고 total은 모두 같은 최종 프레임 수다', () => {
    const frames = eventsOf(happyEvents, 'retrieval.evidence');

    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.map((frame) => frame.index)).toEqual(
      frames.map((_, index) => index),
    );
    expect(new Set(frames.map((frame) => frame.total))).toEqual(
      new Set([frames.length]),
    );
  });

  it('기준 9: retrieval.evidence 순서는 검색 순서와 다른 리랭커 반환 순위를 그대로 보존한다', () => {
    const actualOrder = eventsOf(happyEvents, 'retrieval.evidence').map(
      evidenceIdOf,
    );

    expect(happyCandidateOrder.length).toBeGreaterThanOrEqual(2);
    expect(happyExpectedOrder).toEqual([...happyCandidateOrder].reverse());
    expect(happyExpectedOrder).not.toEqual(happyCandidateOrder);
    expect(actualOrder).toEqual(happyExpectedOrder);
  });

  it('기준 10: retrieval.evidence의 근거는 DTO 키 계약을 지키며 같은 청크 GET 응답과 같다', () => {
    const frames = eventsOf(happyEvents, 'retrieval.evidence');

    expect(frames).toHaveLength(happyExpectedOrder.length);
    for (const frame of frames) {
      expectEvidenceFrameContract(frame);
      const evidence = evidenceRecordOf(frame);
      const oracle = happyEvidenceOracles.get(evidenceIdOf(frame));
      if (!oracle) throw new Error('같은 청크의 GET evidence 오라클이 없습니다.');

      for (const key of EVIDENCE_REQUIRED_KEYS) {
        expect(hasOwn(evidence, key)).toBe(true);
      }
      expect(
        Object.keys(evidence).every((key) => EVIDENCE_ALLOWED_KEYS.has(key)),
      ).toBe(true);
      expect(Object.keys(evidence).sort()).toEqual(Object.keys(oracle).sort());
      expect(evidence).toEqual(oracle);
    }
  });

  it('기준 11: retrieval.completed는 정상·기권 경로 모두 evidence 키 없이 eventType만 싣는다', () => {
    const paths = [
      happyEvents,
      emptyEvidenceEvents,
      distanceGateEvents,
      scoreGateEvents,
      generationGateEvents,
    ];

    for (const events of paths) {
      const completed = expectRetrievalCompletedContract(events);
      expect(hasOwn(completed, 'evidence')).toBe(false);
      expectExactKeys(completed, ['eventType']);
    }
  });

  it('기준 12: 모든 retrieval.evidence는 retrieval.completed 앞에 발신된다', () => {
    const frames = eventsOf(happyEvents, 'retrieval.evidence');

    expect(frames).toHaveLength(happyExpectedOrder.length);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expectAllEvidenceBetweenStartedAndCompleted(happyEvents);
  });

  it('기준 13: 검색 게이트의 근거 0건·거리 컷·점수 컷은 retrieval.evidence를 하나도 발신하지 않는다', () => {
    const searchGatePaths = [
      { name: '근거 0건', events: emptyEvidenceEvents },
      { name: '거리 컷', events: distanceGateEvents },
      { name: '점수 컷', events: scoreGateEvents },
    ];

    expect(progressStages(emptyEvidenceEvents)).toEqual([
      'embedded',
      'searched',
    ]);
    expect(progressStages(distanceGateEvents)).toEqual([
      'embedded',
      'searched',
    ]);
    expect(distanceReranker.calls).toBe(0);
    expect(progressStages(scoreGateEvents)).toEqual([
      'embedded',
      'searched',
      'reranked',
    ]);
    expect(scoreReranker.calls).toBeGreaterThan(0);

    for (const path of searchGatePaths) {
      expect({
        path: path.name,
        evidenceFrameCount: eventsOf(path.events, 'retrieval.evidence').length,
      }).toEqual({ path: path.name, evidenceFrameCount: 0 });
      expect(terminalEvent(path.events).eventType).toBe('answer.abstained');
      expectRetrievalCompletedContract(path.events);
    }
  });

  it('기준 14: 생성 게이트 기권도 최종 근거 수만큼 정상 evidence 프레임을 completed 앞에 보낸다', () => {
    const frames = eventsOf(generationGateEvents, 'retrieval.evidence');

    expect(generationExpectedOrder.length).toBeGreaterThanOrEqual(2);
    expect(frames).toHaveLength(generationExpectedOrder.length);
    expect(frames.map(evidenceIdOf)).toEqual(generationExpectedOrder);
    for (const frame of frames) expectEvidenceFrameContract(frame);
    expectEvidenceIndexContract(frames);
    expectAllEvidenceBetweenStartedAndCompleted(generationGateEvents);
  });

  it('기준 15: responseLang=en의 번역 근거도 같은 프레임 구조와 같은 청크 GET 형태로 온다', () => {
    const frames = eventsOf(englishEvents, 'retrieval.evidence');
    const translatedFrame = frames.find(
      (frame) => evidenceIdOf(frame) === translatedChunkId,
    );

    expect(englishExpectedOrder).toContain(translatedChunkId);
    expect(frames).toHaveLength(englishExpectedOrder.length);
    if (!translatedFrame) {
      throw new Error('번역을 적재한 청크의 retrieval.evidence가 없습니다.');
    }
    expectEvidenceFrameContract(translatedFrame);
    const evidence = evidenceRecordOf(translatedFrame);
    expect(evidence).toMatchObject({
      id: translatedChunkId,
      excerptTranslated: TRANSLATED_EXCERPT,
      translationModel: TRANSLATION_MODEL,
    });
    expect(evidence).toEqual(englishEvidenceOracle);
  });

  it('기준 16: 기존 일곱 이벤트의 키 집합은 그대로이고 신규 세 이벤트 계약도 함께 성립한다', () => {
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
    for (const progress of eventsOf(happyEvents, 'retrieval.progress')) {
      expectExactKeys(
        progress,
        progress.stage === 'searched'
          ? ['eventType', 'stage', 'candidates']
          : ['eventType', 'stage'],
      );
    }
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

    expectAnswerStartedContract(happyEvents, happyExpectedOrder.length);
    const evidenceFrames = eventsOf(happyEvents, 'retrieval.evidence');
    expect(evidenceFrames).toHaveLength(happyExpectedOrder.length);
    for (const frame of evidenceFrames) expectEvidenceFrameContract(frame);
    expectRetrievalCompletedContract(happyEvents);
  });

  it('기준 17: retrieval.progress는 embedded→searched→reranked 순서이고 candidates는 searched에만 있다', () => {
    const progress = eventsOf(happyEvents, 'retrieval.progress');
    const embedded = progressEventOf(happyEvents, 'embedded');
    const searched = progressEventOf(happyEvents, 'searched');
    const reranked = progressEventOf(happyEvents, 'reranked');

    expect(progress.map((event) => event.stage)).toEqual([
      'embedded',
      'searched',
      'reranked',
    ]);
    expectExactKeys(embedded, ['eventType', 'stage']);
    expectExactKeys(searched, ['eventType', 'stage', 'candidates']);
    expect(typeof searched.candidates).toBe('number');
    expect(Number.isInteger(searched.candidates)).toBe(true);
    expectExactKeys(reranked, ['eventType', 'stage']);
    expect(hasOwn(embedded, 'candidates')).toBe(false);
    expect(hasOwn(reranked, 'candidates')).toBe(false);

    const frames = eventsOf(happyEvents, 'retrieval.evidence');
    expect(frames).toHaveLength(happyExpectedOrder.length);
    const firstFrame = frames[0];
    if (!firstFrame) throw new Error('첫 retrieval.evidence가 없습니다.');
    expectEvidenceFrameContract(firstFrame);
    expectAnswerStartedContract(happyEvents, frames.length);
    expectRetrievalCompletedContract(happyEvents);
  });

  it('기준 18: answer.delta seq는 0부터 연속이고 같은 요청의 신규 프레임 계약도 성립한다', () => {
    const deltas = eventsOf(happyEvents, 'answer.delta');
    const frames = eventsOf(happyEvents, 'retrieval.evidence');

    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.map((delta) => delta.seq)).toEqual(
      deltas.map((_, index) => index),
    );
    expectAnswerStartedContract(happyEvents, frames.length);
    expect(frames).toHaveLength(happyExpectedOrder.length);
    for (const frame of frames) expectEvidenceFrameContract(frame);
    expectEvidenceIndexContract(frames);
    expectRetrievalCompletedContract(happyEvents);
  });

  it('기준 19: 스트림 실패는 error·FAILED로, 클라이언트 abort는 CANCELLED로 정리된다', async () => {
    const failureStartedIndex = providerFailureEvents.findIndex(
      (event) => event.eventType === 'answer.started',
    );
    const failureErrorIndex = providerFailureEvents.findIndex(
      (event) => event.eventType === 'error',
    );
    const error = eventOf(providerFailureEvents, 'error');
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
    const failedResult = await pool.query<{ status: string }>(
      'SELECT status FROM messages WHERE id = $1',
      [assistantMessageIdOf(providerFailureEvents)],
    );
    expect(failedResult.rows).toEqual([{ status: 'FAILED' }]);

    const failureFrames = eventsOf(
      providerFailureEvents,
      'retrieval.evidence',
    );
    expect(failureExpectedOrder.length).toBeGreaterThanOrEqual(2);
    expect(failureFrames).toHaveLength(failureExpectedOrder.length);
    expect(failureFrames.map(evidenceIdOf)).toEqual(failureExpectedOrder);
    for (const frame of failureFrames) expectEvidenceFrameContract(frame);
    expect(failureStartedIndex).toBeGreaterThan(-1);
    expect(failureStartedIndex).toBeLessThan(failureErrorIndex);
    expectAnswerStartedContract(
      providerFailureEvents,
      failureFrames.length,
    );
    expectRetrievalCompletedContract(providerFailureEvents);

    const conversationId = await createConversation(abortApp, abortCookie);
    const rerankOrderStart = abortReranker.returnedOrders.length;
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
    expect(status).toBe('CANCELLED');

    const abortOrders = abortReranker.returnedOrders.slice(rerankOrderStart);
    expect(abortOrders).toHaveLength(1);
    expect(abortOrders[0].length).toBeGreaterThanOrEqual(2);
    const abortFrames = eventsOf(observed, 'retrieval.evidence');
    expect(abortFrames.map(evidenceIdOf)).toEqual(abortOrders[0]);
    for (const frame of abortFrames) expectEvidenceFrameContract(frame);
    expectAnswerStartedContract(observed, abortFrames.length);
    expectRetrievalCompletedContract(observed);
    expectAllEvidenceBetweenStartedAndCompleted(observed);
    const abortStartedIndex = observed.findIndex(
      (event) => event.eventType === 'answer.started',
    );
    const abortDeltaIndex = observed.findIndex(
      (event) => event.eventType === 'answer.delta',
    );
    expect(abortStartedIndex).toBeGreaterThan(-1);
    expect(abortDeltaIndex).toBeGreaterThan(-1);
    expect(abortStartedIndex).toBeLessThan(abortDeltaIndex);
  });

  it('기준 20: 첫 delta 요청만 provider TTFT를 1회 관측하고 verdict 기권은 관측하지 않는다', () => {
    const normalFrames = eventsOf(metricProbeEvents, 'retrieval.evidence');
    const gateFrames = eventsOf(
      gateMetricProbeEvents,
      'retrieval.evidence',
    );

    expect(terminalEvent(metricProbeEvents).eventType).toBe(
      'answer.completed',
    );
    expect(eventsOf(metricProbeEvents, 'answer.delta').length).toBeGreaterThan(
      0,
    );
    expect(ttftProvider).toBe(NORMAL_PROVIDER_NAME);
    expect(ttftCountDelta).toBe(1);

    expect(terminalEvent(gateMetricProbeEvents).eventType).toBe(
      'answer.abstained',
    );
    expect(eventsOf(gateMetricProbeEvents, 'answer.delta')).toHaveLength(0);
    expect(gateTtftCountDelta).toBe(0);

    expect(normalFrames.length).toBeGreaterThanOrEqual(2);
    for (const frame of normalFrames) expectEvidenceFrameContract(frame);
    expectAnswerStartedContract(metricProbeEvents, normalFrames.length);
    expectRetrievalCompletedContract(metricProbeEvents);
    expect(gateFrames.length).toBeGreaterThanOrEqual(2);
    for (const frame of gateFrames) expectEvidenceFrameContract(frame);
    expectAnswerStartedContract(gateMetricProbeEvents, gateFrames.length);
    expectRetrievalCompletedContract(gateMetricProbeEvents);
  });
});
