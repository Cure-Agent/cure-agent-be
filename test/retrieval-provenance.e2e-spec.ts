// docs/specs/14 수용 기준 6 동결 테스트 — 구현 중 수정 금지
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
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { socialSignUp } from './fixtures/social-auth';
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

describe('spec 14: 임베딩 provenance 검색 필터', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let cookie: string;

  const signUp = async (email: string): Promise<string> =>
    (await socialSignUp(app, { email })).cookie;

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
      imports: [AppModule],
    })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();

    await app.get(GuidelineIngestService).ingest(yotongGuideline);
    cookie = await signUp('retrieval-provenance@clinic.kr');
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  const ask = async (
    conversationId: string,
    clientRequestId: string,
  ): Promise<SseEvent[]> => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ content: QUESTION, clientRequestId })
      .expect(200);

    return parseSse(res.text);
  };

  it('기준 6: 현재 임베딩 모델의 근거만 검색해 완료·기권·완료로 전환한다', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ type: 'GUIDELINE_QA' })
      .expect(201);
    const conversationId = created.body.data.id as string;

    const initialEvents = await ask(
      conversationId,
      'req-provenance-initial',
    );
    expect(initialEvents[initialEvents.length - 1].eventType).toBe(
      'answer.completed',
    );

    await pool.query(
      'UPDATE evidence_chunks SET embedding_model = $1',
      ['legacy-model'],
    );
    try {
      const legacyEvents = await ask(
        conversationId,
        'req-provenance-legacy',
      );
      expect(legacyEvents[legacyEvents.length - 1].eventType).toBe(
        'answer.abstained',
      );
    } finally {
      await pool.query(
        'UPDATE evidence_chunks SET embedding_model = $1',
        ['fake-embedding-v1'],
      );
    }

    const restoredEvents = await ask(
      conversationId,
      'req-provenance-restored',
    );
    expect(restoredEvents[restoredEvents.length - 1].eventType).toBe(
      'answer.completed',
    );
  });
});
