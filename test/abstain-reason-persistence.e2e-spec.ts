// docs/specs/43 BE 수용 기준 1~11 동결 테스트 — 구현 중 수정 금지
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
import { parseSseEvents, type SseEvent } from './fixtures/sse';

const CSRF = { 'X-CSRF-Protection': '1' };
const KO_QUESTION = '만성 요통 침 치료 권고를 알려 주세요.';
const EN_QUESTION =
  'What does the guideline recommend for chronic low back pain acupuncture?';
const TRANSLATED_QUERY = '만성 요통 침 치료 권고 합성 검색 질의';
const KO_ANSWER = '합성 근거에 따른 한국어 답변입니다 [1].';
const EN_ANSWER =
  'This synthetic English answer is grounded in the cited evidence [1].';
const NO_CANDIDATES_KO =
  '검색 조건에 해당하는 지침 근거를 찾지 못했습니다.';
const NO_CANDIDATES_EN =
  'No guideline evidence matched the selected search filters.';
const EMBEDDING = `[${Array.from({ length: 1536 }, () => '0.001').join(',')}]`;

const GUIDELINE_ID = 'spec43-guideline-lowback';
const VERSION_ID = 'spec43-version-lowback';
const SECTION_ID = 'spec43-section-lowback';
const CHUNK_ID = 'spec43-chunk-lowback';
const NONEXISTENT_GUIDELINE_ID = 'spec43-guideline-does-not-exist';
const PRIMARY_CONTENT = [
  '만성 요통 침 치료 권고 합성 근거입니다.',
  '이 문장은 검색 순위를 결정할 수 있도록 만성 요통과 침 치료라는 표현을 반복합니다.',
  '실제 환자나 실제 진료지침과 무관한 수용 테스트 전용 합성 문장입니다.',
].join(' ');

interface TestRetrievalConfig {
  distanceCutoff: number;
  rerankEnabled: boolean;
  rerankCandidates: number;
  rerankScoreCutoff: number;
  hybridEnabled: boolean;
}

interface MessageRun {
  conversationId: string;
  assistantMessageId: string;
  events: SseEvent[];
}

interface StoredMessage {
  id: string;
  status: string;
  abstain_reason: string | null;
}

class DeterministicTranslator implements Translator {
  readonly model = 'spec43-translator-v1';

  translate(text: string, target: SupportedLang): Promise<string> {
    if (target === 'ko') return Promise.resolve(TRANSLATED_QUERY);
    return Promise.resolve(`[en] ${text}`);
  }
}

class DeterministicAnswerProvider implements LlmProvider {
  readonly model: string;

  constructor(
    readonly name: string,
    private readonly verdict?: LlmAnswerVerdict,
  ) {
    this.model = `${name}-model`;
  }

  async *streamAnswer(
    requestValue: LlmStreamRequest,
  ): AsyncIterable<LlmAnswerChunk> {
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

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

function eventOf(events: SseEvent[], eventType: string): SseEvent {
  const event = events.find((candidate) => candidate.eventType === eventType);
  if (!event) throw new Error(`${eventType} 이벤트가 없습니다.`);
  return event;
}

function assistantMessageIdOf(events: SseEvent[]): string {
  const id = eventOf(events, 'message.accepted').assistantMessageId;
  if (typeof id !== 'string') {
    throw new Error('message.accepted에 assistantMessageId가 없습니다.');
  }
  return id;
}

function abstainedMessageOf(events: SseEvent[]): Record<string, unknown> {
  const message = eventOf(events, 'answer.abstained').message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('answer.abstained에 message 객체가 없습니다.');
  }
  return message as Record<string, unknown>;
}

function messageCollectionOf(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== 'object') {
    throw new Error('응답 body가 객체가 아닙니다.');
  }
  const data = (body as Record<string, unknown>).data;
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === 'object') {
    const envelope = data as Record<string, unknown>;
    for (const key of ['items', 'messages']) {
      if (Array.isArray(envelope[key])) {
        return envelope[key] as Record<string, unknown>[];
      }
    }
  }
  throw new Error('메시지 목록 배열이 없습니다.');
}

function messageById(
  messages: Record<string, unknown>[],
  messageId: string,
): Record<string, unknown> {
  const message = messages.find((candidate) => candidate.id === messageId);
  if (!message) throw new Error(`${messageId} 메시지를 찾지 못했습니다.`);
  return message;
}

function expectEnglishSentence(value: unknown): void {
  expect(value).toEqual(expect.any(String));
  if (typeof value !== 'string') {
    throw new Error('기권 사유가 문자열이 아닙니다.');
  }
  expect(value).toMatch(/[A-Za-z]/);
  expect(value).not.toMatch(/[가-힣]/);
  expect(value.trim()).toMatch(/[.!?]$/);
}

async function seedCorpus(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO guidelines (id, title, publisher, status)
     VALUES ($1, $2, $3, 'ACTIVE')`,
    [GUIDELINE_ID, '만성 요통 진료지침', 'spec43 합성 발행처'],
  );
  await pool.query(
    `INSERT INTO guideline_versions
       (id, guideline_id, version, revision, status, published_at, source_url, content_hash)
     VALUES ($1, $2, '1.0', 1, 'ACTIVE', $3, $4, $5)`,
    [
      VERSION_ID,
      GUIDELINE_ID,
      new Date('2026-08-30T00:00:00.000Z'),
      'https://example.test/spec43-guideline-lowback',
      'spec43-document-hash-v1',
    ],
  );
  await pool.query(
    `INSERT INTO guideline_sections
       (id, guideline_version_id, title, path, "order")
     VALUES ($1, $2, '합성 권고', $3, 1)`,
    [SECTION_ID, VERSION_ID, ['치료', '합성 권고']],
  );
  await pool.query(
    `INSERT INTO evidence_chunks
       (id, section_id, guideline_version_id, content, embedding, embedding_model, "order", content_hash)
     VALUES ($1, $2, $3, $4, $5::vector, 'fake-embedding-v1', 1, $6)`,
    [
      CHUNK_ID,
      SECTION_ID,
      VERSION_ID,
      PRIMARY_CONTENT,
      EMBEDDING,
      'spec43-chunk-hash-v1',
    ],
  );
}

describe('spec 43: 기권 사유 영속화 BE 수용 계약', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let mainApp: INestApplication;
  let beyondCutoffApp: INestApplication;
  let insufficientApp: INestApplication;
  let mainCookie: string;
  let beyondCookie: string;
  let insufficientCookie: string;

  let noCandidatesRun: MessageRun;
  let beyondCutoffRun: MessageRun;
  let insufficientRun: MessageRun;
  let englishNoCandidatesRun: MessageRun;
  let legacyNullReasonRun: MessageRun;
  let mixedAbstainedRun: MessageRun;
  let mixedCompletedRun: MessageRun;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const originalAnswerabilityGate =
    process.env.LLM_ANSWERABILITY_GATE_ENABLED;

  const translator = new DeterministicTranslator();
  const mainProvider = new DeterministicAnswerProvider('spec43-main');
  const beyondProvider = new DeterministicAnswerProvider('spec43-beyond');
  const insufficientProvider = new DeterministicAnswerProvider(
    'spec43-insufficient',
    { insufficientEvidence: true, missingAspects: ['합성 누락 축'] },
  );

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
    responseLang: SupportedLang,
    guidelineIds: string[],
  ): Promise<MessageRun> => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', cookie)
      .send({
        content,
        clientRequestId: randomUUID(),
        responseLang,
        filters: { guidelineIds },
      })
      .expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = parseSseEvents(response.text);
    expect(events.length).toBeGreaterThan(0);
    return {
      conversationId,
      assistantMessageId: assistantMessageIdOf(events),
      events,
    };
  };

  const askNew = async (
    app: INestApplication,
    cookie: string,
    content: string,
    responseLang: SupportedLang,
    guidelineIds: string[],
  ): Promise<MessageRun> => {
    const conversationId = await createConversation(app, cookie);
    return ask(
      app,
      cookie,
      conversationId,
      content,
      responseLang,
      guidelineIds,
    );
  };

  const reloadMessages = async (
    app: INestApplication,
    cookie: string,
    conversationId: string,
  ): Promise<Record<string, unknown>[]> => {
    // GET에는 언어 query/header를 싣지 않는다. 저장된 response_lang만이 렌더 축이다.
    const response = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set('Cookie', cookie)
      .expect(200);
    return messageCollectionOf(response.body);
  };

  const storedMessageOf = async (messageId: string): Promise<StoredMessage> => {
    const result = await pool.query<StoredMessage>(
      `SELECT id, status, abstain_reason
       FROM messages
       WHERE id = $1`,
      [messageId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
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

    mainApp = await createApp(mainProvider, passConfig, false);
    beyondCutoffApp = await createApp(beyondProvider, beyondConfig, false);
    insufficientApp = await createApp(
      insufficientProvider,
      passConfig,
      true,
    );

    mainCookie = (
      await socialSignUp(mainApp, {
        email: 'spec43-main@clinic.kr',
        clinicName: '기권사유합성한의원',
        licenseNumber: 'LIC-4301',
      })
    ).cookie;
    beyondCookie = (
      await socialSignUp(beyondCutoffApp, {
        email: 'spec43-beyond@clinic.kr',
        clinicName: '컷오프합성한의원',
        licenseNumber: 'LIC-4302',
      })
    ).cookie;
    insufficientCookie = (
      await socialSignUp(insufficientApp, {
        email: 'spec43-insufficient@clinic.kr',
        clinicName: '근거부족합성한의원',
        licenseNumber: 'LIC-4303',
      })
    ).cookie;

    noCandidatesRun = await askNew(
      mainApp,
      mainCookie,
      KO_QUESTION,
      'ko',
      [NONEXISTENT_GUIDELINE_ID],
    );
    beyondCutoffRun = await askNew(
      beyondCutoffApp,
      beyondCookie,
      KO_QUESTION,
      'ko',
      [GUIDELINE_ID],
    );
    insufficientRun = await askNew(
      insufficientApp,
      insufficientCookie,
      KO_QUESTION,
      'ko',
      [GUIDELINE_ID],
    );
    englishNoCandidatesRun = await askNew(
      mainApp,
      mainCookie,
      EN_QUESTION,
      'en',
      [NONEXISTENT_GUIDELINE_ID],
    );

    legacyNullReasonRun = await askNew(
      mainApp,
      mainCookie,
      KO_QUESTION,
      'ko',
      [NONEXISTENT_GUIDELINE_ID],
    );
    await pool.query(
      'UPDATE messages SET abstain_reason = NULL WHERE id = $1',
      [legacyNullReasonRun.assistantMessageId],
    );

    const mixedConversationId = await createConversation(mainApp, mainCookie);
    mixedAbstainedRun = await ask(
      mainApp,
      mainCookie,
      mixedConversationId,
      KO_QUESTION,
      'ko',
      [NONEXISTENT_GUIDELINE_ID],
    );
    mixedCompletedRun = await ask(
      mainApp,
      mainCookie,
      mixedConversationId,
      KO_QUESTION,
      'ko',
      [GUIDELINE_ID],
    );
  });

  afterAll(async () => {
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('REDIS_URL', originalRedisUrl);
    restoreEnv('OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnv('ANTHROPIC_API_KEY', originalAnthropicApiKey);
    restoreEnv('LLM_ANSWERABILITY_GATE_ENABLED', originalAnswerabilityGate);

    await insufficientApp?.close();
    await beyondCutoffApp?.close();
    await mainApp?.close();
    await pool?.end();
    await Promise.all([
      postgresContainer?.stop(),
      redisContainer?.stop(),
    ]);
  });

  it('[기준 1] no_candidates 기권 사유 코드를 assistant 메시지 행에 저장한다', async () => {
    const row = await storedMessageOf(noCandidatesRun.assistantMessageId);

    expect(row.status).toBe('ABSTAINED');
    expect(row.abstain_reason).toBe('no_candidates');
  });

  it('[기준 2] beyond_cutoff 기권 사유 코드를 assistant 메시지 행에 저장한다', async () => {
    const row = await storedMessageOf(beyondCutoffRun.assistantMessageId);

    expect(row.status).toBe('ABSTAINED');
    expect(row.abstain_reason).toBe('beyond_cutoff');
  });

  it('[기준 3] 생성 게이트의 insufficient_evidence 사유를 별도 저장 지점에서도 행에 남긴다', async () => {
    const row = await storedMessageOf(insufficientRun.assistantMessageId);

    expect(row.status).toBe('ABSTAINED');
    expect(row.abstain_reason).toBe('insufficient_evidence');
  });

  it('[기준 4] COMPLETED 행은 사유가 null이고 같은 대화의 ABSTAINED 행은 사유가 있다', async () => {
    const completed = await storedMessageOf(
      mixedCompletedRun.assistantMessageId,
    );
    const abstained = await storedMessageOf(
      mixedAbstainedRun.assistantMessageId,
    );

    expect(completed.status).toBe('COMPLETED');
    expect(completed.abstain_reason).toBeNull();
    expect(abstained.status).toBe('ABSTAINED');
    expect(abstained.abstain_reason).not.toBeNull();
  });

  it('[기준 5] 재조회한 ABSTAINED 메시지는 코드가 아닌 사람이 읽는 사유 문장을 싣는다', async () => {
    const messages = await reloadMessages(
      mainApp,
      mainCookie,
      noCandidatesRun.conversationId,
    );
    const message = messageById(messages, noCandidatesRun.assistantMessageId);

    expect(message.status).toBe('ABSTAINED');
    expect(message.abstainReason).toBe(NO_CANDIDATES_KO);
    expect(message.abstainReason).not.toBe('no_candidates');
  });

  it('[기준 6] 세 사유는 재조회에서 서로 다른 3개 문장으로 직렬화된다', async () => {
    const [noCandidatesMessages, beyondMessages, insufficientMessages] =
      await Promise.all([
        reloadMessages(
          mainApp,
          mainCookie,
          noCandidatesRun.conversationId,
        ),
        reloadMessages(
          beyondCutoffApp,
          beyondCookie,
          beyondCutoffRun.conversationId,
        ),
        reloadMessages(
          insufficientApp,
          insufficientCookie,
          insufficientRun.conversationId,
        ),
      ]);
    const reasons = [
      messageById(noCandidatesMessages, noCandidatesRun.assistantMessageId)
        .abstainReason,
      messageById(beyondMessages, beyondCutoffRun.assistantMessageId)
        .abstainReason,
      messageById(insufficientMessages, insufficientRun.assistantMessageId)
        .abstainReason,
    ];

    expect(reasons).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);
    expect(new Set(reasons).size).toBe(3);
  });

  it('[기준 7] 언어 없는 재조회는 행의 response_lang=en을 따라 영문 사유 문장을 싣는다', async () => {
    const stored = await pool.query<{ response_lang: string }>(
      'SELECT response_lang FROM messages WHERE id = $1',
      [englishNoCandidatesRun.assistantMessageId],
    );
    const messages = await reloadMessages(
      mainApp,
      mainCookie,
      englishNoCandidatesRun.conversationId,
    );
    const message = messageById(
      messages,
      englishNoCandidatesRun.assistantMessageId,
    );

    expect(stored.rows).toEqual([{ response_lang: 'en' }]);
    expectEnglishSentence(message.abstainReason);
    expect(message.abstainReason).toBe(NO_CANDIDATES_EN);
  });

  it('[기준 8] 사유가 있는 행만 abstainReason 키를 가지며 null인 과거 행은 키 자체가 없다', async () => {
    const [currentMessages, legacyMessages] = await Promise.all([
      reloadMessages(
        mainApp,
        mainCookie,
        noCandidatesRun.conversationId,
      ),
      reloadMessages(
        mainApp,
        mainCookie,
        legacyNullReasonRun.conversationId,
      ),
    ]);
    const current = messageById(
      currentMessages,
      noCandidatesRun.assistantMessageId,
    );
    const legacy = messageById(
      legacyMessages,
      legacyNullReasonRun.assistantMessageId,
    );

    expect('abstainReason' in current).toBe(true);
    expect('abstainReason' in legacy).toBe(false);
  });

  it('[기준 9] 같은 대화에서 ABSTAINED만 사유 키를 갖고 USER와 COMPLETED는 갖지 않는다', async () => {
    const messages = await reloadMessages(
      mainApp,
      mainCookie,
      mixedAbstainedRun.conversationId,
    );
    const abstained = messageById(
      messages,
      mixedAbstainedRun.assistantMessageId,
    );
    const completed = messageById(
      messages,
      mixedCompletedRun.assistantMessageId,
    );
    const userMessages = messages.filter((message) => message.role === 'USER');

    expect('abstainReason' in abstained).toBe(true);
    expect(completed.status).toBe('COMPLETED');
    expect('abstainReason' in completed).toBe(false);
    expect(userMessages.length).toBeGreaterThan(0);
    for (const userMessage of userMessages) {
      expect('abstainReason' in userMessage).toBe(false);
    }
  });

  it('[기준 10] 스트림 message와 같은 id를 재조회하면 abstainReason 자구가 정확히 같다', async () => {
    const streamed = abstainedMessageOf(noCandidatesRun.events);
    const messages = await reloadMessages(
      mainApp,
      mainCookie,
      noCandidatesRun.conversationId,
    );
    const reloaded = messageById(messages, noCandidatesRun.assistantMessageId);

    expect(streamed.id).toBe(noCandidatesRun.assistantMessageId);
    expect(reloaded.id).toBe(streamed.id);
    expect(streamed.abstainReason).toEqual(expect.any(String));
    expect(reloaded.abstainReason).toEqual(expect.any(String));
    expect(streamed.abstainReason).toBe(reloaded.abstainReason);
  });

  it('[기준 11] answer.abstained의 reason 계약을 유지하고 message.abstainReason과 같은 문장을 낸다', () => {
    const event = eventOf(noCandidatesRun.events, 'answer.abstained');
    const message = abstainedMessageOf(noCandidatesRun.events);

    expect(event).toHaveProperty('reason');
    expect(event.reason).toEqual(expect.any(String));
    expect(message.abstainReason).toEqual(expect.any(String));
    expect(event.reason).toBe(message.abstainReason);
  });
});
