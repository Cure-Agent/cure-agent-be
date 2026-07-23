import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import {
  LLM_PROVIDERS,
  LlmProvider,
  LlmProviderError,
} from '../src/infrastructure/llm/llm-provider.port';
import { yotongGuideline } from './fixtures/guideline-samples';

const CSRF = { 'X-CSRF-Protection': '1' };
const QUESTION = '만성 요통 환자에게 침 치료가 효과적인가요?';

interface SseEvent {
  eventType: string;
  [key: string]: unknown;
}

/** SSE 응답 본문(data: 프레임)을 이벤트 배열로 파싱 */
function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as SseEvent);
}

/** 테스트 전용 프로바이더: 항상 실패 */
const failingProvider: LlmProvider = {
  name: 'always-fail',
  // eslint-disable-next-line require-yield
  async *streamAnswer(): AsyncIterable<string> {
    throw new LlmProviderError('provider down', { retryable: false });
  },
};

/** 테스트 전용 프로바이더: 고정 응답 */
const okProvider: LlmProvider = {
  name: 'test-ok',
  async *streamAnswer(): AsyncIterable<string> {
    yield '침 치료는 만성 요통에 ';
    yield '권고됩니다 [1].';
  },
};

describe('spec 06: Conversation·Message + SSE + LLM 게이트웨이', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;

  let cookieA: string; // 의사 A
  let cookieB: string; // 의사 B (스코프 검증용)
  let ingestedChunkIds: string[] = [];

  let convId: string; // A의 대화 (해피패스)
  let assistantMessageId: string;

  const signUp = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        email,
        password: 'password-1234',
        displayName: '김의사',
        clinicName: '서울한의원',
        licenseNumber: 'LIC-0042',
        termsAccepted: true,
      })
      .expect(201);
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    return cookies
      .map((raw) => raw.split(';')[0])
      .filter((pair) => pair.startsWith('access_token='))
      .join('; ');
  };

  const buildApp = async (
    customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
  ): Promise<INestApplication> => {
    let builder = Test.createTestingModule({ imports: [AppModule] });
    if (customize) builder = customize(builder);
    const moduleRef = await builder.compile();
    const instance = moduleRef.createNestApplication();
    instance.setGlobalPrefix('api/v1');
    instance.use(cookieParser());
    await instance.init();
    return instance;
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

    app = await buildApp();
    await app.get(GuidelineIngestService).ingest(yotongGuideline);
    const { rows } = await pool.query('SELECT id FROM evidence_chunks');
    ingestedChunkIds = rows.map((r: { id: string }) => r.id);

    cookieA = await signUp('doctor-a@clinic.kr');
    cookieB = await signUp('doctor-b@clinic.kr');
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  const server = () => app.getHttpServer();

  it('기준 1: 대화 생성(GUIDELINE_QA) 201 + 기본 title, PATIENT_GUIDANCE는 400', async () => {
    const created = await request(server())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', cookieA)
      .send({ type: 'GUIDELINE_QA' })
      .expect(201);
    expect(created.body.code).toBe('CREATED');
    expect(created.body.data).toMatchObject({ type: 'GUIDELINE_QA', title: expect.any(String) });
    convId = created.body.data.id;

    const rejected = await request(server())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', cookieA)
      .send({ type: 'PATIENT_GUIDANCE' })
      .expect(400);
    expect(rejected.body.code).toBe('BAD_REQUEST');
  });

  it('기준 4: SSE 해피패스 — 이벤트 순서·seq·citations·GenerationRun', async () => {
    const res = await request(server())
      .post(`/api/v1/conversations/${convId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', cookieA)
      .send({ content: QUESTION, clientRequestId: 'req-happy-1' })
      .expect(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(res.text);
    const types = events.map((e) => e.eventType);

    // 순서: accepted → retrieval.started → retrieval.completed → delta+ → answer.completed
    expect(types[0]).toBe('message.accepted');
    expect(types[1]).toBe('retrieval.started');
    expect(types[2]).toBe('retrieval.completed');
    expect(types[types.length - 1]).toBe('answer.completed');

    const accepted = events[0] as {
      requestId: string;
      userMessageId: string;
      assistantMessageId: string;
    } & SseEvent;
    expect(accepted.requestId).toBe('req-happy-1');
    assistantMessageId = accepted.assistantMessageId;

    const retrieval = events[2] as { evidence: { id: string }[] } & SseEvent;
    expect(retrieval.evidence.length).toBeGreaterThanOrEqual(1);
    for (const item of retrieval.evidence) {
      expect(ingestedChunkIds).toContain(item.id);
    }

    const deltas = events.filter((e) => e.eventType === 'answer.delta') as ({
      messageId: string;
      seq: number;
      delta: string;
    } & SseEvent)[];
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    deltas.forEach((d, i) => {
      expect(d.seq).toBe(i);
      expect(d.messageId).toBe(assistantMessageId);
    });

    const completed = events[events.length - 1] as {
      message: {
        id: string;
        status: string;
        content: string;
        citations: { marker: number; evidenceId: string }[];
      };
    } & SseEvent;
    expect(completed.message.id).toBe(assistantMessageId);
    expect(completed.message.status).toBe('COMPLETED');
    expect(completed.message.content).toBe(deltas.map((d) => d.delta).join(''));
    expect(completed.message.citations.length).toBeGreaterThanOrEqual(1);
    for (const citation of completed.message.citations) {
      expect(citation.marker).toBeGreaterThanOrEqual(1);
      expect(ingestedChunkIds).toContain(citation.evidenceId);
    }

    const db = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM messages WHERE conversation_id = $1) AS messages,
        (SELECT count(*)::int FROM message_citations WHERE message_id = $2) AS citations,
        (SELECT count(*)::int FROM generation_runs WHERE message_id = $2) AS runs,
        (SELECT provider FROM generation_runs WHERE message_id = $2) AS provider,
        (SELECT trace_id FROM generation_runs WHERE message_id = $2) AS trace_id`,
      [convId, assistantMessageId],
    );
    expect(db.rows[0].messages).toBe(2);
    expect(db.rows[0].citations).toBeGreaterThanOrEqual(1);
    expect(db.rows[0].runs).toBe(1);
    expect(db.rows[0].provider).toBeTruthy();
    expect(db.rows[0].trace_id).toBeTruthy();
  });

  it('기준 5: clientRequestId 중복 → 409 봉투, 메시지 추가 생성 없음', async () => {
    const res = await request(server())
      .post(`/api/v1/conversations/${convId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', cookieA)
      .send({ content: QUESTION, clientRequestId: 'req-happy-1' })
      .expect(409);
    expect(res.body).toMatchObject({ success: false, code: 'DUPLICATE_CLIENT_REQUEST' });

    const { rows } = await pool.query(
      'SELECT count(*)::int AS count FROM messages WHERE conversation_id = $1',
      [convId],
    );
    expect(rows[0].count).toBe(2);
  });

  it('기준 6: 근거 0건(미존재 지침 필터) → answer.abstained + ABSTAINED 저장', async () => {
    const created = await request(server())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', cookieA)
      .send({ type: 'GUIDELINE_QA' })
      .expect(201);
    const emptyConvId = created.body.data.id;

    const res = await request(server())
      .post(`/api/v1/conversations/${emptyConvId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', cookieA)
      .send({
        content: QUESTION,
        clientRequestId: 'req-abstain-1',
        filters: { guidelineIds: ['01JNOSUCHGUIDELINEXXXXXXXX'] },
      })
      .expect(200);

    const events = parseSse(res.text);
    const abstained = events.find((e) => e.eventType === 'answer.abstained') as {
      message: { status: string };
      reason: string;
    } & SseEvent;
    expect(abstained).toBeDefined();
    expect(abstained.message.status).toBe('ABSTAINED');
    expect(typeof abstained.reason).toBe('string');
    expect(events.find((e) => e.eventType === 'answer.completed')).toBeUndefined();

    const { rows } = await pool.query(
      "SELECT status FROM messages WHERE conversation_id = $1 AND role = 'ASSISTANT'",
      [emptyConvId],
    );
    expect(rows).toEqual([{ status: 'ABSTAINED' }]);
  });

  it('기준 7: GET messages 시간순 + 최종 상태 반영 (§8 복구 폴백)', async () => {
    const res = await request(server())
      .get(`/api/v1/conversations/${convId}/messages`)
      .set('Cookie', cookieA)
      .expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ role: 'USER', content: QUESTION });
    expect(res.body.data[1]).toMatchObject({ id: assistantMessageId, status: 'COMPLETED' });
    expect(res.body.data[1].citations.length).toBeGreaterThanOrEqual(1);

    const paged = await request(server())
      .get(`/api/v1/conversations/${convId}/messages`)
      .query({ size: 1 })
      .set('Cookie', cookieA)
      .expect(200);
    expect(paged.body.data).toHaveLength(1);
    expect(paged.body.data[0].role).toBe('USER');
    expect(paged.body.page.hasNext).toBe(true);
  });

  it('기준 2: GET /conversations 본인 것만 + 커서', async () => {
    const listA = await request(server())
      .get('/api/v1/conversations')
      .set('Cookie', cookieA)
      .expect(200);
    expect(listA.body.data.length).toBeGreaterThanOrEqual(2);

    const page1 = await request(server())
      .get('/api/v1/conversations')
      .query({ size: 1 })
      .set('Cookie', cookieA)
      .expect(200);
    expect(page1.body.data).toHaveLength(1);
    expect(page1.body.page.hasNext).toBe(true);

    const listB = await request(server())
      .get('/api/v1/conversations')
      .set('Cookie', cookieB)
      .expect(200);
    expect(listB.body.data).toHaveLength(0);
  });

  it('기준 3: 타 계정 대화 접근 → 전부 404 (§4.4)', async () => {
    const detail = await request(server())
      .get(`/api/v1/conversations/${convId}`)
      .set('Cookie', cookieB)
      .expect(404);
    expect(detail.body.code).toBe('NOT_FOUND');

    await request(server())
      .get(`/api/v1/conversations/${convId}/messages`)
      .set('Cookie', cookieB)
      .expect(404);

    await request(server())
      .post(`/api/v1/conversations/${convId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', cookieB)
      .send({ content: QUESTION, clientRequestId: 'req-intruder-1' })
      .expect(404);

    await request(server())
      .post(`/api/v1/messages/${assistantMessageId}/feedback`)
      .set(CSRF)
      .set('Cookie', cookieB)
      .send({ rating: 'HELPFUL' })
      .expect(404);
  });

  it('기준 10: 피드백 저장·재제출 갱신, 미인증 401', async () => {
    await request(server())
      .post(`/api/v1/messages/${assistantMessageId}/feedback`)
      .set(CSRF)
      .set('Cookie', cookieA)
      .send({ rating: 'HELPFUL', comment: '도움이 됐습니다' })
      .expect(200);

    await request(server())
      .post(`/api/v1/messages/${assistantMessageId}/feedback`)
      .set(CSRF)
      .set('Cookie', cookieA)
      .send({ rating: 'NOT_HELPFUL', reasonCodes: ['INACCURATE'] })
      .expect(200);

    const { rows } = await pool.query(
      'SELECT rating FROM answer_feedbacks WHERE message_id = $1',
      [assistantMessageId],
    );
    expect(rows).toEqual([{ rating: 'NOT_HELPFUL' }]);

    await request(server())
      .post(`/api/v1/messages/${assistantMessageId}/feedback`)
      .set(CSRF)
      .send({ rating: 'HELPFUL' })
      .expect(401);
  });

  it('기준 8: 프로바이더 폴백 — 1순위 실패 시 2순위로 완료 + GenerationRun 기록', async () => {
    const fallbackApp = await buildApp((builder) =>
      builder.overrideProvider(LLM_PROVIDERS).useValue([failingProvider, okProvider]),
    );
    try {
      const cookie = await (async () => {
        const res = await request(fallbackApp.getHttpServer())
          .post('/api/v1/auth/login')
          .set(CSRF)
          .send({ email: 'doctor-a@clinic.kr', password: 'password-1234' })
          .expect(200);
        const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
        return cookies
          .map((raw) => raw.split(';')[0])
          .filter((pair) => pair.startsWith('access_token='))
          .join('; ');
      })();

      const created = await request(fallbackApp.getHttpServer())
        .post('/api/v1/conversations')
        .set(CSRF)
        .set('Cookie', cookie)
        .send({ type: 'GUIDELINE_QA' })
        .expect(201);

      const res = await request(fallbackApp.getHttpServer())
        .post(`/api/v1/conversations/${created.body.data.id}/messages/stream`)
        .set(CSRF)
        .set('Cookie', cookie)
        .send({ content: QUESTION, clientRequestId: 'req-fallback-1' })
        .expect(200);

      const events = parseSse(res.text);
      const completed = events.find((e) => e.eventType === 'answer.completed') as {
        message: { id: string; status: string };
      } & SseEvent;
      expect(completed).toBeDefined();
      expect(completed.message.status).toBe('COMPLETED');

      const { rows } = await pool.query(
        'SELECT provider FROM generation_runs WHERE message_id = $1',
        [completed.message.id],
      );
      expect(rows).toEqual([{ provider: 'test-ok' }]);
    } finally {
      await fallbackApp.close();
    }
  });

  it('기준 9: 전 프로바이더 실패 → error 이벤트(LLM_UNAVAILABLE) + FAILED 저장', async () => {
    const brokenApp = await buildApp((builder) =>
      builder.overrideProvider(LLM_PROVIDERS).useValue([failingProvider]),
    );
    try {
      const login = await request(brokenApp.getHttpServer())
        .post('/api/v1/auth/login')
        .set(CSRF)
        .send({ email: 'doctor-a@clinic.kr', password: 'password-1234' })
        .expect(200);
      const cookies = (login.headers['set-cookie'] ?? []) as unknown as string[];
      const cookie = cookies
        .map((raw) => raw.split(';')[0])
        .filter((pair) => pair.startsWith('access_token='))
        .join('; ');

      const created = await request(brokenApp.getHttpServer())
        .post('/api/v1/conversations')
        .set(CSRF)
        .set('Cookie', cookie)
        .send({ type: 'GUIDELINE_QA' })
        .expect(201);

      const res = await request(brokenApp.getHttpServer())
        .post(`/api/v1/conversations/${created.body.data.id}/messages/stream`)
        .set(CSRF)
        .set('Cookie', cookie)
        .send({ content: QUESTION, clientRequestId: 'req-broken-1' })
        .expect(200);

      const events = parseSse(res.text);
      const error = events.find((e) => e.eventType === 'error') as {
        code: string;
        retryable: boolean;
        traceId: string;
      } & SseEvent;
      expect(error).toBeDefined();
      expect(error.code).toBe('LLM_UNAVAILABLE');
      expect(error.retryable).toBe(true);
      expect(error.traceId).toBeTruthy();
      expect(events.find((e) => e.eventType === 'answer.completed')).toBeUndefined();

      const { rows } = await pool.query(
        "SELECT status FROM messages WHERE conversation_id = $1 AND role = 'ASSISTANT'",
        [created.body.data.id],
      );
      expect(rows).toEqual([{ status: 'FAILED' }]);
    } finally {
      await brokenApp.close();
    }
  });

  it('기준 11: 스트리밍 중 클라이언트 abort → 메시지 CANCELLED (§8-4)', async () => {
    await app.listen(0);
    const url = await app.getUrl();

    const created = await request(server())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', cookieA)
      .send({ type: 'GUIDELINE_QA' })
      .expect(201);
    const abortConvId = created.body.data.id;

    const controller = new AbortController();
    const response = await fetch(`${url}/api/v1/conversations/${abortConvId}/messages/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Protection': '1',
        Cookie: cookieA,
      },
      body: JSON.stringify({ content: QUESTION, clientRequestId: 'req-abort-1' }),
      signal: controller.signal,
    });

    // 첫 이벤트(message.accepted) 수신 후 즉시 중단
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('message.accepted');
    controller.abort();

    // 서버가 CANCELLED로 정리할 때까지 폴링 (최대 5초)
    let status = '';
    for (let i = 0; i < 25; i += 1) {
      const { rows } = await pool.query(
        "SELECT status FROM messages WHERE conversation_id = $1 AND role = 'ASSISTANT'",
        [abortConvId],
      );
      status = rows[0]?.status ?? '';
      if (status === 'CANCELLED') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(status).toBe('CANCELLED');
  });
});
