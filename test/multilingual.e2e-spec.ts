// docs/specs/42 BE 수용 기준 1~27 동결 테스트 — 구현 중 수정 금지
import { randomUUID } from 'node:crypto';
import { INestApplication, Type } from '@nestjs/common';
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
import { ChunkTranslatorService } from '../src/domain/guideline/service/chunk-translator.service';
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
  TRANSLATOR,
  type SupportedLang,
  type Translator,
} from '../src/infrastructure/llm/translation/translator.port';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { socialSignUp } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const KO_QUESTION = '만성 요통 침 치료 권고를 알려 주세요.';
const EN_QUESTION = 'What does the guideline recommend for chronic low back pain acupuncture?';
const TRANSLATED_QUERY = '만성 요통 침 치료 권고 합성 검색 질의';
const KO_ANSWER = '합성 근거에 따른 한국어 답변입니다 [1].';
const EN_ANSWER = 'This synthetic English answer is grounded in the cited evidence [1].';
const NO_CANDIDATES_KO = '검색 조건에 해당하는 지침 근거를 찾지 못했습니다.';
const BEYOND_CUTOFF_KO = '질문과 충분히 관련된 지침 근거를 찾지 못했습니다.';
const INSUFFICIENT_KO = '찾은 지침 근거만으로는 이 질문에 답하기 어렵습니다.';
const EMBEDDING = `[${Array.from({ length: 1536 }, () => '0.001').join(',')}]`;

const PRIMARY_GUIDELINE_ID = 'spec42-guideline-lowback';
const PRIMARY_VERSION_ID = 'spec42-version-lowback';
const PRIMARY_SECTION_ID = 'spec42-section-lowback';
const PRIMARY_CHUNK_ID = 'spec42-chunk-lowback';
const PRIMARY_HASH = 'spec42-hash-lowback-v1';
const MISSING_GUIDELINE_ID = 'spec42-guideline-osteoporosis';
const MISSING_CHUNK_ID = 'spec42-chunk-osteoporosis';
const STALE_GUIDELINE_ID = 'spec42-guideline-migraine';
const STALE_CHUNK_ID = 'spec42-chunk-migraine';
const ADHD_CHUNK_ID = 'spec42-chunk-adhd-tab';
const OUTSIDE_CHUNK_ID = 'spec42-chunk-outside';
const FRESH_TRANSLATION_ID = 'spec42-translation-lowback-en';
const STALE_TRANSLATION_ID = 'spec42-translation-migraine-en';
const NONEXISTENT_GUIDELINE_ID = 'spec42-guideline-does-not-exist';

const PRIMARY_CONTENT = [
  '만성 요통 침 치료 권고 합성 근거입니다.',
  '이 문장은 검색 순위를 결정할 수 있도록 만성 요통과 침 치료라는 표현을 반복합니다.',
  '인용 원문이 120자를 넘도록 실제 환자나 실 지침과 무관한 합성 문장을 충분히 덧붙입니다.',
  '원문 대조용 quote는 이 합성 한국어 청크에서 만들어져야 합니다.',
].join(' ');
const MISSING_CONTENT =
  '골다공증 합성 청크이며 번역 행을 일부러 넣지 않은 근거입니다.';
const STALE_CONTENT =
  '편두통 합성 청크이며 원문 해시와 다른 낡은 번역 행을 가진 근거입니다.';
const LONG_EN_TRANSLATION = Array.from(
  { length: 270 },
  (_, index) => String.fromCharCode(97 + (index % 26)),
).join('');
const EXPECTED_QUOTE = `${PRIMARY_CONTENT.slice(0, 120)}…`;
const EXPECTED_QUOTE_TRANSLATED = `${LONG_EN_TRANSLATION.slice(0, 240)}…`;

interface SseEvent {
  eventType: string;
  [key: string]: unknown;
}

interface TranslatorCall {
  text: string;
  target: SupportedLang;
}

interface AskTrace {
  events: SseEvent[];
  translatorCalls: TranslatorCall[];
  searchCalls: unknown[][];
}

interface TestRetrievalConfig {
  distanceCutoff: number;
  rerankEnabled: boolean;
  rerankCandidates: number;
  rerankScoreCutoff: number;
  hybridEnabled: boolean;
}

interface RetrievalLike {
  searchHybrid(...args: unknown[]): Promise<unknown>;
}

interface FixtureGuideline {
  guidelineId: string;
  versionId: string;
  sectionId: string;
  chunkId: string;
  title: string;
  content: string;
  contentHash: string;
}

const FIXTURE_GUIDELINES: FixtureGuideline[] = [
  {
    guidelineId: PRIMARY_GUIDELINE_ID,
    versionId: PRIMARY_VERSION_ID,
    sectionId: PRIMARY_SECTION_ID,
    chunkId: PRIMARY_CHUNK_ID,
    title: '만성 요통 진료지침',
    content: PRIMARY_CONTENT,
    contentHash: PRIMARY_HASH,
  },
  {
    guidelineId: MISSING_GUIDELINE_ID,
    versionId: 'spec42-version-osteoporosis',
    sectionId: 'spec42-section-osteoporosis',
    chunkId: MISSING_CHUNK_ID,
    title: '골다공증 진료지침',
    content: MISSING_CONTENT,
    contentHash: 'spec42-hash-osteoporosis-v1',
  },
  {
    guidelineId: 'spec42-guideline-adhd',
    versionId: 'spec42-version-adhd',
    sectionId: 'spec42-section-adhd',
    chunkId: ADHD_CHUNK_ID,
    title: '주의력결핍 과잉행동장애 진료지침\t',
    content: '주의력결핍 과잉행동장애 합성 ACTIVE 청크입니다.',
    contentHash: 'spec42-hash-adhd-v1',
  },
  {
    guidelineId: 'spec42-guideline-rheumatoid',
    versionId: 'spec42-version-rheumatoid',
    sectionId: 'spec42-section-rheumatoid',
    chunkId: 'spec42-chunk-rheumatoid',
    title: '류마티스 관절염 진료지침',
    content: '류마티스 관절염 합성 ACTIVE 청크입니다.',
    contentHash: 'spec42-hash-rheumatoid-v1',
  },
  {
    guidelineId: 'spec42-guideline-insomnia',
    versionId: 'spec42-version-insomnia',
    sectionId: 'spec42-section-insomnia',
    chunkId: 'spec42-chunk-insomnia',
    title: '불면장애 진료지침',
    content: '불면장애 합성 ACTIVE 청크입니다.',
    contentHash: 'spec42-hash-insomnia-v1',
  },
  {
    guidelineId: STALE_GUIDELINE_ID,
    versionId: 'spec42-version-migraine',
    sectionId: 'spec42-section-migraine',
    chunkId: STALE_CHUNK_ID,
    title: '편두통 진료지침',
    content: STALE_CONTENT,
    contentHash: 'spec42-hash-migraine-v1',
  },
  {
    guidelineId: 'spec42-guideline-outside',
    versionId: 'spec42-version-outside',
    sectionId: 'spec42-section-outside',
    chunkId: OUTSIDE_CHUNK_ID,
    title: '감기 진료지침',
    content: '6주제 밖 감기 지침의 합성 ACTIVE 청크입니다.',
    contentHash: 'spec42-hash-outside-v1',
  },
];

class RecordingTranslator implements Translator {
  readonly model = 'recording-translator-v1';
  readonly calls: TranslatorCall[] = [];

  translate(text: string, target: SupportedLang): Promise<string> {
    this.calls.push({ text, target });
    if (target === 'ko') return Promise.resolve(TRANSLATED_QUERY);
    return Promise.resolve(`[en] ${text}`);
  }
}

class ThrowingTranslator implements Translator {
  readonly model = 'throwing-translator-v1';
  readonly calls: TranslatorCall[] = [];

  translate(text: string, target: SupportedLang): Promise<string> {
    this.calls.push({ text, target });
    return Promise.reject(new Error('spec42 deterministic translator failure'));
  }
}

class LanguageAwareAnswerProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly requests: LlmStreamRequest[] = [];

  constructor(
    name: string,
    private readonly verdict?: LlmAnswerVerdict,
  ) {
    this.name = name;
    this.model = `${name}-model`;
  }

  async *streamAnswer(requestValue: LlmStreamRequest): AsyncIterable<LlmAnswerChunk> {
    this.requests.push(requestValue);
    if (this.verdict) {
      yield {
        kind: 'verdict',
        insufficientEvidence: this.verdict.insufficientEvidence,
        missingAspects: [...this.verdict.missingAspects],
      };
    }

    const responseLang = (
      requestValue as LlmStreamRequest & { responseLang?: SupportedLang }
    ).responseLang;
    yield {
      kind: 'delta',
      text: responseLang === 'en' ? EN_ANSWER : KO_ANSWER,
    };
  }
}

function parseSse(body: string): SseEvent[] {
  return body
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => frame.split(/\r?\n/))
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as SseEvent);
}

function eventOf(events: SseEvent[], eventType: string): SseEvent {
  const event = events.find((candidate) => candidate.eventType === eventType);
  if (!event) throw new Error(`${eventType} 이벤트가 없습니다.`);
  return event;
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

function completedMessageOf(events: SseEvent[]): Record<string, unknown> {
  const message = eventOf(events, 'answer.completed').message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('answer.completed에 message 객체가 없습니다.');
  }
  return message as Record<string, unknown>;
}

function citationsOfMessage(message: Record<string, unknown>): Record<string, unknown>[] {
  const citations = message.citations;
  if (!Array.isArray(citations)) throw new Error('message.citations가 배열이 아닙니다.');
  return citations as Record<string, unknown>[];
}

function citationOf(events: SseEvent[], evidenceId: string): Record<string, unknown> {
  const citation = citationsOfMessage(completedMessageOf(events)).find(
    (candidate) => candidate.evidenceId === evidenceId,
  );
  if (!citation) throw new Error(`${evidenceId} 인용이 없습니다.`);
  return citation;
}

function retrievalEvidenceOf(events: SseEvent[]): Record<string, unknown>[] {
  const evidence = eventOf(events, 'retrieval.completed').evidence;
  if (!Array.isArray(evidence)) {
    throw new Error('retrieval.completed evidence가 배열이 아닙니다.');
  }
  return evidence as Record<string, unknown>[];
}

function evidenceIdOf(value: Record<string, unknown>): string {
  const id = value.id ?? value.evidenceId ?? value.chunkId;
  if (typeof id !== 'string') throw new Error('근거 id가 문자열이 아닙니다.');
  return id;
}

function retrievalEvidenceItemOf(
  events: SseEvent[],
  evidenceId: string,
): Record<string, unknown> {
  const evidence = retrievalEvidenceOf(events).find(
    (candidate) => evidenceIdOf(candidate) === evidenceId,
  );
  if (!evidence) throw new Error(`${evidenceId} 검색 근거가 없습니다.`);
  return evidence;
}

function answerTextOf(events: SseEvent[]): string {
  const completed = events.find((event) => event.eventType === 'answer.completed');
  if (completed?.message && typeof completed.message === 'object') {
    const content = (completed.message as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
  }

  return events
    .filter((event) => event.eventType === 'answer.delta')
    .map(
      (event) =>
        event.delta ?? event.text ?? event.content ?? event.contentDelta,
    )
    .filter((value): value is string => typeof value === 'string')
    .join('');
}

function abstainReasonOf(events: SseEvent[]): string {
  const reason = eventOf(events, 'answer.abstained').reason;
  if (typeof reason !== 'string') {
    throw new Error('answer.abstained reason이 문자열이 아닙니다.');
  }
  return reason;
}

function messageCollectionOf(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== 'object') throw new Error('응답 body가 객체가 아닙니다.');
  const envelope = body as Record<string, unknown>;
  const data = envelope.data;
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === 'object') {
    const object = data as Record<string, unknown>;
    for (const key of ['items', 'messages']) {
      if (Array.isArray(object[key])) return object[key] as Record<string, unknown>[];
    }
  }
  throw new Error('메시지 목록 배열이 없습니다.');
}

function searchQuestionsOf(trace: AskTrace): unknown[] {
  return trace.searchCalls.map((call) => call[0]);
}

function expectEnglishSentence(value: string): void {
  expect(value).toMatch(/[A-Za-z]/);
  expect(value).not.toMatch(/[가-힣]/);
  expect(value.trim()).toMatch(/[.!?]$/);
}

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

function retrievalServiceToken(): Type<RetrievalLike> {
  // 레포의 기존 배치 위치 차이를 테스트 계약으로 만들지 않되 실제 Nest provider를 감시한다.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('../src/domain/guideline/service/retrieval.service') as {
      RetrievalService?: Type<RetrievalLike>;
    };
    if (!module.RetrievalService) throw new Error('RetrievalService export missing');
    return module.RetrievalService;
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('../src/infrastructure/retrieval/retrieval.service') as {
      RetrievalService?: Type<RetrievalLike>;
    };
    if (!module.RetrievalService) throw new Error('RetrievalService export missing');
    return module.RetrievalService;
  }
}

async function seedCorpus(pool: Pool): Promise<void> {
  for (const fixture of FIXTURE_GUIDELINES) {
    await pool.query(
      `INSERT INTO guidelines (id, title, publisher, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [fixture.guidelineId, fixture.title, 'spec42 합성 발행처'],
    );
    await pool.query(
      `INSERT INTO guideline_versions
         (id, guideline_id, version, revision, status, published_at, source_url, content_hash)
       VALUES ($1, $2, '1.0', 1, 'ACTIVE', $3, $4, $5)`,
      [
        fixture.versionId,
        fixture.guidelineId,
        new Date('2026-08-29T00:00:00.000Z'),
        `https://example.test/${fixture.guidelineId}`,
        `${fixture.contentHash}-document`,
      ],
    );
    await pool.query(
      `INSERT INTO guideline_sections
         (id, guideline_version_id, title, path, "order")
       VALUES ($1, $2, '합성 권고', $3, 1)`,
      [fixture.sectionId, fixture.versionId, ['치료', '합성 권고']],
    );
    await pool.query(
      `INSERT INTO evidence_chunks
         (id, section_id, guideline_version_id, content, embedding, embedding_model, "order", content_hash)
       VALUES ($1, $2, $3, $4, $5::vector, 'fake-embedding-v1', 1, $6)`,
      [
        fixture.chunkId,
        fixture.sectionId,
        fixture.versionId,
        fixture.content,
        EMBEDDING,
        fixture.contentHash,
      ],
    );
  }

  await pool.query(
    `INSERT INTO evidence_chunk_translations
       (id, chunk_id, lang, content, source_content_hash, translator_model)
     VALUES ($1, $2, 'en', $3, $4, 'fixture-translator-v1')`,
    [FRESH_TRANSLATION_ID, PRIMARY_CHUNK_ID, LONG_EN_TRANSLATION, PRIMARY_HASH],
  );
  await pool.query(
    `INSERT INTO evidence_chunk_translations
       (id, chunk_id, lang, content, source_content_hash, translator_model)
     VALUES ($1, $2, 'en', $3, 'obsolete-source-hash', 'fixture-translator-v0')`,
    [STALE_TRANSLATION_ID, STALE_CHUNK_ID, 'obsolete English translation'],
  );
}

async function insertPrimaryChunk(
  pool: Pool,
  chunkId: string,
  content: string,
  contentHash: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO evidence_chunks
       (id, section_id, guideline_version_id, content, embedding, embedding_model, "order", content_hash)
     VALUES ($1, $2, $3, $4, $5::vector, 'fake-embedding-v1', 99, $6)`,
    [chunkId, PRIMARY_SECTION_ID, PRIMARY_VERSION_ID, content, EMBEDDING, contentHash],
  );
}

describe('spec 42: 다국어 데모 BE 수용 계약', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let mainApp: INestApplication;
  let failingApp: INestApplication;
  let beyondCutoffApp: INestApplication;
  let insufficientApp: INestApplication;
  let mainCookie: string;
  let failingCookie: string;
  let beyondCookie: string;
  let insufficientCookie: string;

  const mainTranslator = new RecordingTranslator();
  const failingTranslator = new ThrowingTranslator();
  const beyondTranslator = new RecordingTranslator();
  const insufficientTranslator = new RecordingTranslator();
  const mainProvider = new LanguageAwareAnswerProvider('spec42-main');
  const failingProvider = new LanguageAwareAnswerProvider('spec42-failing');
  const beyondProvider = new LanguageAwareAnswerProvider('spec42-beyond');
  const insufficientProvider = new LanguageAwareAnswerProvider(
    'spec42-insufficient',
    { insufficientEvidence: true, missingAspects: ['합성 누락 축'] },
  );

  let mainSearchSpy: jest.SpyInstance;
  let failingSearchSpy: jest.SpyInstance;
  let koreanDefaultTrace: AskTrace;
  let englishFreshTrace: AskTrace;
  let englishMissingTrace: AskTrace;
  let englishStaleTrace: AskTrace;
  let failingTrace: AskTrace;
  let noCandidatesEnEvents: SseEvent[];
  let noCandidatesKoEvents: SseEvent[];
  let beyondEnEvents: SseEvent[];
  let beyondKoEvents: SseEvent[];
  let insufficientEnEvents: SseEvent[];
  let insufficientKoEvents: SseEvent[];
  let englishConversationId: string;
  let reloadedEnglishMessage: Record<string, unknown>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const originalAnswerabilityGate = process.env.LLM_ANSWERABILITY_GATE_ENABLED;

  const passConfig: TestRetrievalConfig = {
    distanceCutoff: 2,
    rerankEnabled: false,
    rerankCandidates: 30,
    rerankScoreCutoff: 6,
    hybridEnabled: true,
  };

  const beyondConfig: TestRetrievalConfig = {
    ...passConfig,
    distanceCutoff: 0.000001,
    hybridEnabled: false,
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
    translator: Translator,
    provider: LlmProvider,
    config: TestRetrievalConfig,
    gateEnabled: boolean,
  ): Promise<INestApplication> =>
    withGateEnv(gateEnabled, async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(OAuthProviderRegistry)
        .useClass(FakeOAuthProviderRegistry)
        .overrideProvider(TRANSLATOR)
        .useValue(translator)
        .overrideProvider(LLM_PROVIDERS)
        .useValue([provider])
        .overrideProvider(retrievalConfig.KEY)
        .useValue(config)
        .compile();

      const app = moduleRef.createNestApplication();
      app.setGlobalPrefix('api/v1');
      app.use(cookieParser());
      await bootstrapApp(app);
      return app;
    });

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
    content: string,
    responseLang?: SupportedLang,
    guidelineIds?: string[],
  ): Promise<SseEvent[]> => {
    const body: Record<string, unknown> = {
      content,
      clientRequestId: randomUUID(),
    };
    if (responseLang !== undefined) body.responseLang = responseLang;
    if (guidelineIds !== undefined) body.filters = { guidelineIds };

    const response = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', cookie)
      .send(body)
      .expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = parseSse(response.text);
    expect(events.length).toBeGreaterThan(0);
    return events;
  };

  const askNew = async (
    app: INestApplication,
    cookie: string,
    content: string,
    responseLang?: SupportedLang,
    guidelineIds?: string[],
  ): Promise<SseEvent[]> => {
    const conversationId = await createConversation(app, cookie);
    return ask(app, cookie, conversationId, content, responseLang, guidelineIds);
  };

  const tracedAskNew = async (
    app: INestApplication,
    cookie: string,
    translator: RecordingTranslator | ThrowingTranslator,
    searchSpy: jest.SpyInstance,
    content: string,
    responseLang: SupportedLang | undefined,
    guidelineIds: string[],
  ): Promise<AskTrace> => {
    const translatorCallStart = translator.calls.length;
    const searchCallStart = searchSpy.mock.calls.length;
    const events = await askNew(
      app,
      cookie,
      content,
      responseLang,
      guidelineIds,
    );
    return {
      events,
      translatorCalls: translator.calls.slice(translatorCallStart),
      searchCalls: searchSpy.mock.calls
        .slice(searchCallStart)
        .map((call) => [...call] as unknown[]),
    };
  };

  const generationRunOf = async (
    messageId: string,
  ): Promise<Record<string, unknown>> => {
    const result = await pool.query<{ run: Record<string, unknown> }>(
      `SELECT to_jsonb(generation_runs) AS run
       FROM generation_runs
       WHERE message_id = $1`,
      [messageId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0].run;
  };

  beforeAll(async () => {
    [postgresContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = postgresContainer.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();
    process.env.OPENAI_API_KEY = '';
    process.env.ANTHROPIC_API_KEY = '';

    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });
    await seedCorpus(pool);

    mainApp = await createApp(mainTranslator, mainProvider, passConfig, false);
    failingApp = await createApp(
      failingTranslator,
      failingProvider,
      passConfig,
      false,
    );
    beyondCutoffApp = await createApp(
      beyondTranslator,
      beyondProvider,
      beyondConfig,
      false,
    );
    insufficientApp = await createApp(
      insufficientTranslator,
      insufficientProvider,
      passConfig,
      true,
    );

    const RetrievalService = retrievalServiceToken();
    const mainRetrieval = mainApp.get<RetrievalLike>(RetrievalService);
    const failingRetrieval = failingApp.get<RetrievalLike>(RetrievalService);
    mainSearchSpy = jest.spyOn(mainRetrieval, 'searchHybrid');
    failingSearchSpy = jest.spyOn(failingRetrieval, 'searchHybrid');

    mainCookie = (
      await socialSignUp(mainApp, {
        email: 'spec42-main@clinic.kr',
        clinicName: '다국어합성한의원',
        licenseNumber: 'LIC-4201',
      })
    ).cookie;
    failingCookie = (
      await socialSignUp(failingApp, {
        email: 'spec42-failing@clinic.kr',
        clinicName: '번역실패합성한의원',
        licenseNumber: 'LIC-4202',
      })
    ).cookie;
    beyondCookie = (
      await socialSignUp(beyondCutoffApp, {
        email: 'spec42-beyond@clinic.kr',
        clinicName: '컷오프합성한의원',
        licenseNumber: 'LIC-4203',
      })
    ).cookie;
    insufficientCookie = (
      await socialSignUp(insufficientApp, {
        email: 'spec42-insufficient@clinic.kr',
        clinicName: '근거부족합성한의원',
        licenseNumber: 'LIC-4204',
      })
    ).cookie;

    koreanDefaultTrace = await tracedAskNew(
      mainApp,
      mainCookie,
      mainTranslator,
      mainSearchSpy,
      KO_QUESTION,
      undefined,
      [PRIMARY_GUIDELINE_ID],
    );

    englishConversationId = await createConversation(mainApp, mainCookie);
    const enTranslatorStart = mainTranslator.calls.length;
    const enSearchStart = mainSearchSpy.mock.calls.length;
    const englishFreshEvents = await ask(
      mainApp,
      mainCookie,
      englishConversationId,
      EN_QUESTION,
      'en',
      [PRIMARY_GUIDELINE_ID],
    );
    englishFreshTrace = {
      events: englishFreshEvents,
      translatorCalls: mainTranslator.calls.slice(enTranslatorStart),
      searchCalls: mainSearchSpy.mock.calls
        .slice(enSearchStart)
        .map((call) => [...call] as unknown[]),
    };

    englishMissingTrace = await tracedAskNew(
      mainApp,
      mainCookie,
      mainTranslator,
      mainSearchSpy,
      EN_QUESTION,
      'en',
      [MISSING_GUIDELINE_ID],
    );
    englishStaleTrace = await tracedAskNew(
      mainApp,
      mainCookie,
      mainTranslator,
      mainSearchSpy,
      EN_QUESTION,
      'en',
      [STALE_GUIDELINE_ID],
    );
    failingTrace = await tracedAskNew(
      failingApp,
      failingCookie,
      failingTranslator,
      failingSearchSpy,
      EN_QUESTION,
      'en',
      [PRIMARY_GUIDELINE_ID],
    );

    noCandidatesEnEvents = await askNew(
      mainApp,
      mainCookie,
      EN_QUESTION,
      'en',
      [NONEXISTENT_GUIDELINE_ID],
    );
    noCandidatesKoEvents = await askNew(
      mainApp,
      mainCookie,
      KO_QUESTION,
      'ko',
      [NONEXISTENT_GUIDELINE_ID],
    );
    beyondEnEvents = await askNew(
      beyondCutoffApp,
      beyondCookie,
      EN_QUESTION,
      'en',
      [PRIMARY_GUIDELINE_ID],
    );
    beyondKoEvents = await askNew(
      beyondCutoffApp,
      beyondCookie,
      KO_QUESTION,
      'ko',
      [PRIMARY_GUIDELINE_ID],
    );
    insufficientEnEvents = await askNew(
      insufficientApp,
      insufficientCookie,
      EN_QUESTION,
      'en',
      [PRIMARY_GUIDELINE_ID],
    );
    insufficientKoEvents = await askNew(
      insufficientApp,
      insufficientCookie,
      KO_QUESTION,
      'ko',
      [PRIMARY_GUIDELINE_ID],
    );

    const messagesResponse = await request(mainApp.getHttpServer())
      .get(`/api/v1/conversations/${englishConversationId}/messages`)
      .set('Cookie', mainCookie)
      .expect(200);
    const englishMessageId = assistantMessageIdOf(englishFreshTrace.events);
    const reloaded = messageCollectionOf(messagesResponse.body).find(
      (message) => message.id === englishMessageId,
    );
    if (!reloaded) throw new Error('재조회한 영문 assistant 메시지가 없습니다.');
    reloadedEnglishMessage = reloaded;
  });

  afterAll(async () => {
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('REDIS_URL', originalRedisUrl);
    restoreEnv('OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnv('ANTHROPIC_API_KEY', originalAnthropicApiKey);
    restoreEnv('LLM_ANSWERABILITY_GATE_ENABLED', originalAnswerabilityGate);

    jest.restoreAllMocks();
    await insufficientApp?.close();
    await beyondCutoffApp?.close();
    await failingApp?.close();
    await mainApp?.close();
    await pool?.end();
    await Promise.all([
      postgresContainer?.stop(),
      redisContainer?.stop(),
    ]);
  });

  it('[기준 1] 한국어 질의로 스트림을 열면 번역기를 한 번도 호출하지 않는다', () => {
    expect(terminalEvent(koreanDefaultTrace.events).eventType).toBe('answer.completed');
    expect(koreanDefaultTrace.translatorCalls).toEqual([]);

    // 영문 양성 대조로, 번역 기능 자체가 없는 현재 경로의 공허한 0회 통과를 막는다.
    expect(englishFreshTrace.translatorCalls).toEqual([
      { text: EN_QUESTION, target: 'ko' },
    ]);
  });

  it('[기준 2] 한국어 질의에서 searchHybrid에 넘어간 문자열은 요청 원문과 문자 그대로 같다', () => {
    expect(searchQuestionsOf(koreanDefaultTrace)).toEqual([KO_QUESTION]);
    expect(searchQuestionsOf(englishFreshTrace)).toEqual([TRANSLATED_QUERY]);
  });

  it('[기준 3] responseLang이 없으면 ko로 처리되어 번역기 미호출과 한국어 답변 경로를 유지한다', () => {
    expect(koreanDefaultTrace.translatorCalls).toEqual([]);
    expect(answerTextOf(koreanDefaultTrace.events)).toBe(KO_ANSWER);

    // 명시적 en 요청과 갈라져야 default 검사가 단순한 기존 동작 확인에 머물지 않는다.
    expect(englishFreshTrace.translatorCalls).toEqual([
      { text: EN_QUESTION, target: 'ko' },
    ]);
    expect(answerTextOf(englishFreshTrace.events)).toBe(EN_ANSWER);
  });

  it('[기준 4] 한국어 경로에 기록되는 promptVersion은 qa-v6이다', async () => {
    const koreanRun = await generationRunOf(
      assistantMessageIdOf(koreanDefaultTrace.events),
    );
    const englishControl = await generationRunOf(
      assistantMessageIdOf(englishFreshTrace.events),
    );

    expect(koreanRun.prompt_version).toBe('qa-v6');
    expect(englishControl.prompt_version).toBe('qa-v6-en');
  });

  it('[기준 5] responseLang=en이면 searchHybrid 입력은 번역기 산출물이고 요청 원문이 아니다', () => {
    const questions = searchQuestionsOf(englishFreshTrace);
    expect(englishFreshTrace.translatorCalls).toEqual([
      { text: EN_QUESTION, target: 'ko' },
    ]);
    expect(questions).toEqual([TRANSLATED_QUERY]);
    expect(questions).not.toContain(EN_QUESTION);
  });

  it('[기준 6a] GenerationRun에는 사용자가 보낸 원문 질의가 남는다', async () => {
    const run = await generationRunOf(
      assistantMessageIdOf(englishFreshTrace.events),
    );
    const serialized = JSON.stringify(run);

    expect(serialized).toContain(EN_QUESTION);
    // 영문 버전 양성 대조가 있어 기존 run의 우연한 원문 포함만으로 통과하지 않는다.
    expect(run.prompt_version).toBe('qa-v6-en');
  });

  it('[기준 6b] 같은 GenerationRun에는 검색에 쓴 번역 질의도 남는다', async () => {
    const run = await generationRunOf(
      assistantMessageIdOf(englishFreshTrace.events),
    );
    const serialized = JSON.stringify(run);

    expect(serialized).toContain(EN_QUESTION);
    expect(serialized).toContain(TRANSLATED_QUERY);
  });

  it('[기준 7a] 번역기 예외는 스트림을 code LLM_UNAVAILABLE인 error 이벤트로 끝낸다', () => {
    expect(failingTranslator.calls).toContainEqual({
      text: EN_QUESTION,
      target: 'ko',
    });
    expect(terminalEvent(failingTrace.events)).toMatchObject({
      eventType: 'error',
      code: 'LLM_UNAVAILABLE',
    });
  });

  it('[기준 7b] 번역기가 실패하면 searchHybrid를 원문으로 호출하지 않는다', () => {
    expect(failingTrace.translatorCalls).toEqual([
      { text: EN_QUESTION, target: 'ko' },
    ]);
    expect(failingTrace.searchCalls).toHaveLength(0);
  });

  it('[기준 9] 영문 경로에 기록되는 promptVersion은 qa-v6-en이다', async () => {
    const run = await generationRunOf(
      assistantMessageIdOf(englishFreshTrace.events),
    );
    expect(run.prompt_version).toBe('qa-v6-en');
    expect(run.prompt_version).not.toBe('qa-v6');
  });

  it('[기준 10] messages.response_lang에는 답변을 생성한 언어가 저장된다', async () => {
    const messageId = assistantMessageIdOf(englishFreshTrace.events);
    const result = await pool.query<{ response_lang: string }>(
      'SELECT response_lang FROM messages WHERE id = $1',
      [messageId],
    );
    expect(result.rows).toEqual([{ response_lang: 'en' }]);
  });

  it('[기준 11] 메시지 재조회는 언어 요청 없이 저장된 언어의 인용 번역을 싣는다', () => {
    expect(reloadedEnglishMessage.content).toBe(EN_ANSWER);
    const citation = citationsOfMessage(reloadedEnglishMessage).find(
      (candidate) => candidate.evidenceId === PRIMARY_CHUNK_ID,
    );
    expect(citation).toMatchObject({
      evidenceId: PRIMARY_CHUNK_ID,
      quote: EXPECTED_QUOTE,
      quoteTranslated: EXPECTED_QUOTE_TRANSLATED,
    });
  });

  it('[기준 12a] 번역이 있는 청크의 인용에는 quoteTranslated가 실린다', () => {
    const citation = citationOf(englishFreshTrace.events, PRIMARY_CHUNK_ID);
    expect(citation).toMatchObject({
      quote: EXPECTED_QUOTE,
      quoteTranslated: EXPECTED_QUOTE_TRANSLATED,
    });
  });

  it('[기준 12b] 같은 응답의 근거 상세에는 excerptTranslated가 실린다', () => {
    const evidence = retrievalEvidenceItemOf(
      englishFreshTrace.events,
      PRIMARY_CHUNK_ID,
    );
    expect(evidence).toMatchObject({
      id: PRIMARY_CHUNK_ID,
      excerptTranslated: LONG_EN_TRANSLATION,
      translationModel: 'fixture-translator-v1',
    });
  });

  it('[기준 14] 번역이 없는 청크는 번역 필드의 키 자체가 응답에서 빠진다', () => {
    const translated = citationOf(englishFreshTrace.events, PRIMARY_CHUNK_ID);
    const untranslated = citationOf(englishMissingTrace.events, MISSING_CHUNK_ID);

    expect(translated.quoteTranslated).toBe(EXPECTED_QUOTE_TRANSLATED);
    expect(untranslated).not.toHaveProperty('quoteTranslated');
    expect(untranslated).not.toHaveProperty('titleTranslated');
    const detail = retrievalEvidenceItemOf(
      englishMissingTrace.events,
      MISSING_CHUNK_ID,
    );
    expect(detail).not.toHaveProperty('excerptTranslated');
    expect(detail).not.toHaveProperty('translationModel');
  });

  it('[기준 15] source_content_hash가 원문 content_hash와 다르면 번역 키를 싣지 않는다', () => {
    const fresh = citationOf(englishFreshTrace.events, PRIMARY_CHUNK_ID);
    const stale = citationOf(englishStaleTrace.events, STALE_CHUNK_ID);

    expect(fresh.quoteTranslated).toBe(EXPECTED_QUOTE_TRANSLATED);
    expect(stale).not.toHaveProperty('quoteTranslated');
    const staleDetail = retrievalEvidenceItemOf(
      englishStaleTrace.events,
      STALE_CHUNK_ID,
    );
    expect(staleDetail).not.toHaveProperty('excerptTranslated');
    expect(staleDetail).not.toHaveProperty('translationModel');
  });

  it('[기준 16] responseLang=ko 응답에는 번역 행이 있어도 번역 키가 실리지 않는다', () => {
    const englishCitation = citationOf(
      englishFreshTrace.events,
      PRIMARY_CHUNK_ID,
    );
    const koreanCitation = citationOf(
      koreanDefaultTrace.events,
      PRIMARY_CHUNK_ID,
    );

    expect(englishCitation.quoteTranslated).toBe(EXPECTED_QUOTE_TRANSLATED);
    expect(koreanCitation).not.toHaveProperty('quoteTranslated');
    expect(koreanCitation).not.toHaveProperty('titleTranslated');
    const koreanDetail = retrievalEvidenceItemOf(
      koreanDefaultTrace.events,
      PRIMARY_CHUNK_ID,
    );
    expect(koreanDetail).not.toHaveProperty('excerptTranslated');
    expect(koreanDetail).not.toHaveProperty('translationModel');
  });

  it('[기준 17] quote 한국어 원문은 번역 유무와 무관하게 항상 실린다', () => {
    const translated = citationOf(englishFreshTrace.events, PRIMARY_CHUNK_ID);
    const untranslated = citationOf(englishMissingTrace.events, MISSING_CHUNK_ID);

    expect(translated.quote).toBe(EXPECTED_QUOTE);
    expect(translated.quoteTranslated).toBe(EXPECTED_QUOTE_TRANSLATED);
    expect(untranslated.quote).toBe(MISSING_CONTENT);
    expect(untranslated).not.toHaveProperty('quoteTranslated');
  });

  it('[기준 18] 번역 잡을 두 번 실행해도 evidence_chunk_translations 행 수가 늘지 않는다', async () => {
    const chunkId = `spec42-idempotent-${randomUUID()}`;
    await insertPrimaryChunk(
      pool,
      chunkId,
      '멱등성 확인용 합성 ACTIVE 청크',
      `spec42-idempotent-hash-${randomUUID()}`,
    );
    const job = mainApp.get(ChunkTranslatorService);
    const before = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM evidence_chunk_translations',
    );

    const first = await job.translatePending({ scope: 'demo', target: 'en' });
    const afterFirst = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM evidence_chunk_translations',
    );
    const second = await job.translatePending({ scope: 'demo', target: 'en' });
    const afterSecond = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM evidence_chunk_translations',
    );

    expect(first.translated).toBeGreaterThan(0);
    expect(afterFirst.rows[0].count).toBeGreaterThan(before.rows[0].count);
    expect(afterSecond.rows[0].count).toBe(afterFirst.rows[0].count);
    expect(second.translated).toBe(0);
    expect(second.skipped).toBe(second.targeted);
  });

  it('[기준 19a] 기본 scope=demo 잡은 6주제 지침의 ACTIVE 청크를 대상으로 삼는다', async () => {
    await mainApp
      .get(ChunkTranslatorService)
      .translatePending({ scope: 'demo', target: 'en' });

    const demoChunkIds = FIXTURE_GUIDELINES
      .filter((fixture) => fixture.chunkId !== OUTSIDE_CHUNK_ID)
      .map((fixture) => fixture.chunkId);
    const result = await pool.query<{ chunk_id: string }>(
      `SELECT chunk_id
       FROM evidence_chunk_translations
       WHERE lang = 'en' AND chunk_id = ANY($1::text[])`,
      [demoChunkIds],
    );
    expect(new Set(result.rows.map((row) => row.chunk_id))).toEqual(
      new Set(demoChunkIds),
    );
  });

  it('[기준 19b] 기본 scope=demo 잡은 6주제 밖 지침의 청크를 번역하지 않는다', async () => {
    const jobResult = await mainApp
      .get(ChunkTranslatorService)
      .translatePending({ scope: 'demo', target: 'en' });
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM evidence_chunk_translations
       WHERE chunk_id = $1 AND lang = 'en'`,
      [OUTSIDE_CHUNK_ID],
    );

    expect(jobResult.targeted).toBeGreaterThan(0);
    expect(result.rows[0].count).toBe(0);
  });

  it('[기준 20] 후행 탭이 붙은 주의력결핍 과잉행동장애 지침도 demo 대상에 포함된다', async () => {
    await mainApp
      .get(ChunkTranslatorService)
      .translatePending({ scope: 'demo', target: 'en' });
    const result = await pool.query<{
      title: string;
      count: number;
    }>(
      `SELECT g.title, count(t.id)::int AS count
       FROM guidelines g
       JOIN guideline_versions gv ON gv.guideline_id = g.id
       JOIN evidence_chunks ec ON ec.guideline_version_id = gv.id
       LEFT JOIN evidence_chunk_translations t
         ON t.chunk_id = ec.id AND t.lang = 'en'
       WHERE ec.id = $1
       GROUP BY g.title`,
      [ADHD_CHUNK_ID],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title.endsWith('\t')).toBe(true);
    expect(result.rows[0].count).toBe(1);
  });

  it('[기준 21] 원문 content_hash가 바뀌면 기존 번역을 stale로 판정해 다시 번역한다', async () => {
    const job = mainApp.get(ChunkTranslatorService);
    await job.translatePending({ scope: 'demo', target: 'en' });
    const before = await pool.query<{
      content: string;
      source_content_hash: string;
    }>(
      `SELECT content, source_content_hash
       FROM evidence_chunk_translations
       WHERE chunk_id = $1 AND lang = 'en'`,
      [STALE_CHUNK_ID],
    );
    const revisedContent = `개정된 편두통 합성 청크 ${randomUUID()}`;
    const revisedHash = `spec42-hash-migraine-revised-${randomUUID()}`;
    await pool.query(
      `UPDATE evidence_chunks
       SET content = $1, content_hash = $2
       WHERE id = $3`,
      [revisedContent, revisedHash, STALE_CHUNK_ID],
    );

    const rerun = await job.translatePending({ scope: 'demo', target: 'en' });
    const after = await pool.query<{
      content: string;
      source_content_hash: string;
      translator_model: string;
    }>(
      `SELECT content, source_content_hash, translator_model
       FROM evidence_chunk_translations
       WHERE chunk_id = $1 AND lang = 'en'`,
      [STALE_CHUNK_ID],
    );

    expect(rerun.translated).toBeGreaterThan(0);
    expect(after.rows).toEqual([
      {
        content: `[en] ${revisedContent}`,
        source_content_hash: revisedHash,
        translator_model: mainTranslator.model,
      },
    ]);
    expect(after.rows[0].content).not.toBe(before.rows[0].content);
  });

  it('[기준 22] 잡이 만든 각 번역 행에는 translator_model이 기록된다', async () => {
    await mainApp
      .get(ChunkTranslatorService)
      .translatePending({ scope: 'demo', target: 'en' });
    const result = await pool.query<{ translator_model: string }>(
      `SELECT translator_model
       FROM evidence_chunk_translations
       WHERE chunk_id = $1 AND lang = 'en'`,
      [MISSING_CHUNK_ID],
    );

    expect(result.rows).toEqual([{ translator_model: mainTranslator.model }]);
  });

  it('[기준 23] 같은 질의의 searchHybrid 결과는 번역 적재 전후 순서와 id가 모두 같다', async () => {
    const chunkId = `spec42-search-invariance-${randomUUID()}`;
    await insertPrimaryChunk(
      pool,
      chunkId,
      '검색 불변성 확인용 만성 요통 침 치료 합성 ACTIVE 청크',
      `spec42-search-invariance-hash-${randomUUID()}`,
    );

    const beforeEvents = await askNew(
      mainApp,
      mainCookie,
      KO_QUESTION,
      'ko',
      [PRIMARY_GUIDELINE_ID],
    );
    const beforeIds = retrievalEvidenceOf(beforeEvents).map(evidenceIdOf);

    await mainApp
      .get(ChunkTranslatorService)
      .translatePending({ scope: 'demo', target: 'en' });
    const inserted = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM evidence_chunk_translations
       WHERE chunk_id = $1 AND lang = 'en'`,
      [chunkId],
    );

    const afterEvents = await askNew(
      mainApp,
      mainCookie,
      KO_QUESTION,
      'ko',
      [PRIMARY_GUIDELINE_ID],
    );
    const afterIds = retrievalEvidenceOf(afterEvents).map(evidenceIdOf);

    expect(inserted.rows[0].count).toBe(1);
    expect(beforeIds.length).toBeGreaterThan(0);
    expect(afterIds).toEqual(beforeIds);
  });

  // 기준 25는 test/contract의 기존 openapi:export 재생성 비교가 소유한다. 중복 검사를 만들지 않는다.

  it('[기준 26a] no_candidates는 responseLang=en에서 영문 문장을 낸다', () => {
    const reason = abstainReasonOf(noCandidatesEnEvents);
    expect(terminalEvent(noCandidatesEnEvents).eventType).toBe('answer.abstained');
    expectEnglishSentence(reason);
  });

  it('[기준 26b] beyond_cutoff는 en에서 no_candidates와 다른 영문 문장을 낸다', () => {
    const noCandidates = abstainReasonOf(noCandidatesEnEvents);
    const beyondCutoff = abstainReasonOf(beyondEnEvents);
    expectEnglishSentence(beyondCutoff);
    expect(beyondCutoff).not.toBe(noCandidates);
  });

  it('[기준 26c] insufficient_evidence는 en에서 앞의 둘과 다른 영문 문장을 낸다', () => {
    const noCandidates = abstainReasonOf(noCandidatesEnEvents);
    const beyondCutoff = abstainReasonOf(beyondEnEvents);
    const insufficient = abstainReasonOf(insufficientEnEvents);
    expectEnglishSentence(insufficient);
    expect(new Set([noCandidates, beyondCutoff, insufficient]).size).toBe(3);
  });

  it('[기준 27a] no_candidates의 한국어 문구는 기존 자구와 같다', () => {
    const englishControl = abstainReasonOf(noCandidatesEnEvents);
    expect(abstainReasonOf(noCandidatesKoEvents)).toBe(NO_CANDIDATES_KO);
    expectEnglishSentence(englishControl);
    expect(englishControl).not.toBe(NO_CANDIDATES_KO);
  });

  it('[기준 27b] beyond_cutoff의 한국어 문구는 기존 자구와 같다', () => {
    const englishControl = abstainReasonOf(beyondEnEvents);
    expect(abstainReasonOf(beyondKoEvents)).toBe(BEYOND_CUTOFF_KO);
    expectEnglishSentence(englishControl);
    expect(englishControl).not.toBe(BEYOND_CUTOFF_KO);
  });

  it('[기준 27c] insufficient_evidence의 한국어 문구는 기존 자구와 같다', () => {
    const englishControl = abstainReasonOf(insufficientEnEvents);
    expect(abstainReasonOf(insufficientKoEvents)).toBe(INSUFFICIENT_KO);
    expectEnglishSentence(englishControl);
    expect(englishControl).not.toBe(INSUFFICIENT_KO);
  });
});
