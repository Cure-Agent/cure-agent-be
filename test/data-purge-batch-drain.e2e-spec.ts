// 이슈 #473 수용 기준 동결 테스트 — 구현 중 수정 금지
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
import { DataPurgeService } from '../src/domain/data-purge/service/data-purge.service';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { yotongGuideline } from './fixtures/guideline-samples';
import { socialSignUp, type TestSession } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const GUIDELINE_QUESTION = '만성 요통 환자에게 침 치료가 효과적인가요?';
const PATIENT_GUIDANCE_QUESTION = '이 환자에게 적용할 임상 지침을 알려 주세요.';

type ConversationType = 'GUIDELINE_QA' | 'PATIENT_GUIDANCE';

interface PatientDto {
  id: string;
  caseLabel: string;
  version: number;
}

interface SseEvent {
  eventType: string;
  message?: { id?: string; [key: string]: unknown };
  guidance?: { id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

const parseSse = (raw: string): SseEvent[] =>
  raw
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => frame.split(/\r?\n/))
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as SseEvent);

describe('이슈 #473: 대화가 남은 환자 보류와 틱별 파기', () => {
  jest.setTimeout(180_000);

  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let owner: TestSession;
  let patientSequence = 0;

  const previousPurgeEnv = {
    enabled: process.env.DATA_PURGE_ENABLED,
    cron: process.env.DATA_PURGE_CRON,
    retentionDays: process.env.DATA_PURGE_RETENTION_DAYS,
    lockTtlMs: process.env.DATA_PURGE_LOCK_TTL_MS,
    batchSize: process.env.DATA_PURGE_BATCH_SIZE,
    maxBatchesPerTick: process.env.DATA_PURGE_MAX_BATCHES_PER_TICK,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
  };

  const restoreEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

  const server = () => app.getHttpServer();

  const createPatient = async (
    session: TestSession = owner,
    caseLabel?: string,
  ): Promise<PatientDto> => {
    patientSequence += 1;
    const body = {
      caseLabel: caseLabel ?? `배치동결-${String(patientSequence).padStart(3, '0')}`,
      birthYear: 1985,
      sex: 'FEMALE',
      heightCm: 165,
      weightKg: 60,
      waistCm: 76,
      diagnoses: ['합성 진단'],
      medications: ['합성 약물'],
      allergies: [],
      clinicalNotes: '이슈 #473 합성 환자 fixture',
    };

    const response = await request(server())
      .post('/api/v1/patients')
      .set(CSRF)
      .set('Cookie', session.cookie)
      .send(body)
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      data: { id: expect.any(String), caseLabel: body.caseLabel },
    });
    return response.body.data as PatientDto;
  };

  const createConversation = async ({
    session = owner,
    type = 'GUIDELINE_QA',
    patientId,
    title,
  }: {
    session?: TestSession;
    type?: ConversationType;
    patientId?: string;
    title?: string;
  } = {}): Promise<string> => {
    const response = await request(server())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', session.cookie)
      .send({ type, patientId, title })
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      data: { id: expect.any(String), type },
    });
    return response.body.data.id as string;
  };

  const deleteConversation = async (
    session: TestSession,
    conversationId: string,
  ): Promise<void> => {
    const response = await request(server())
      .delete(`/api/v1/conversations/${conversationId}`)
      .set(CSRF)
      .set('Cookie', session.cookie)
      .expect(200);

    expect(response.body).toMatchObject({ success: true, data: null, page: null });
  };

  const deletePatient = async (
    session: TestSession,
    patientId: string,
  ): Promise<void> => {
    const response = await request(server())
      .delete(`/api/v1/patients/${patientId}`)
      .set(CSRF)
      .set('Cookie', session.cookie)
      .expect(200);

    expect(response.body).toMatchObject({ success: true, data: null, page: null });
  };

  const streamCompleted = async (
    session: TestSession,
    conversationId: string,
    content = GUIDELINE_QUESTION,
  ): Promise<SseEvent> => {
    const response = await request(server())
      .post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', session.cookie)
      .send({ content, clientRequestId: randomUUID() })
      .expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    const completed = parseSse(response.text).find(
      (event) => event.eventType === 'answer.completed',
    );
    expect(completed).toBeDefined();
    if (!completed) throw new Error('answer.completed 이벤트를 찾지 못했습니다.');
    return completed;
  };

  const countRows = async (sql: string, values: unknown[]): Promise<number> => {
    const result = await pool.query<{ count: number }>(sql, values);
    return result.rows[0].count;
  };

  const conversationCount = (conversationId: string): Promise<number> =>
    countRows('SELECT count(*)::int AS count FROM conversations WHERE id = $1', [
      conversationId,
    ]);

  const patientCount = (patientId: string): Promise<number> =>
    countRows('SELECT count(*)::int AS count FROM patients WHERE id = $1', [patientId]);

  const snapshotCountForPatient = (patientId: string): Promise<number> =>
    countRows(
      'SELECT count(*)::int AS count FROM patient_profile_snapshots WHERE patient_id = $1',
      [patientId],
    );

  const guidanceCountForPatient = (patientId: string): Promise<number> =>
    countRows(
      'SELECT count(*)::int AS count FROM clinical_guidances WHERE patient_id = $1',
      [patientId],
    );

  const markConversationPastRetention = async (
    conversationId: string,
    days: 399 | 400,
  ): Promise<void> => {
    const result = await pool.query(
      `UPDATE conversations
          SET deleted_at = now() - $2::interval
        WHERE id = $1`,
      [conversationId, `${days} days`],
    );
    expect(result.rowCount).toBe(1);
  };

  const markPatientPastRetention = async (
    patientId: string,
    days: 399 | 400,
  ): Promise<void> => {
    const result = await pool.query(
      `UPDATE patients
          SET deleted_at = now() - $2::interval
        WHERE id = $1`,
      [patientId, `${days} days`],
    );
    expect(result.rowCount).toBe(1);
  };

  const createDeferredPatientFixture = async () => {
    const unrelatedConversationIds = [
      await createConversation(),
      await createConversation(),
    ];
    for (const conversationId of unrelatedConversationIds) {
      await deleteConversation(owner, conversationId);
      await markConversationPastRetention(conversationId, 400);
    }

    const patient = await createPatient();
    const conversationId = await createConversation({
      type: 'PATIENT_GUIDANCE',
      patientId: patient.id,
    });
    await streamCompleted(owner, conversationId, PATIENT_GUIDANCE_QUESTION);

    // 실제 스냅샷 참조가 없으면 스텁의 FK 교착을 재현하지 못한다.
    expect(await guidanceCountForPatient(patient.id)).toBeGreaterThan(0);
    expect(await snapshotCountForPatient(patient.id)).toBeGreaterThan(0);

    await deletePatient(owner, patient.id);
    const deletedConversation = await pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM conversations WHERE id = $1',
      [conversationId],
    );
    expect(deletedConversation.rows).toHaveLength(1);
    expect(deletedConversation.rows[0].deleted_at).not.toBeNull();
    await markPatientPastRetention(patient.id, 399);
    await markConversationPastRetention(conversationId, 399);

    return { patientId: patient.id, conversationId, unrelatedConversationIds };
  };

  beforeAll(async () => {
    process.env.DATA_PURGE_ENABLED = 'false';
    process.env.DATA_PURGE_CRON = '0 0 1 1 *';
    process.env.DATA_PURGE_RETENTION_DAYS = '30';
    process.env.DATA_PURGE_LOCK_TTL_MS = '60000';
    process.env.DATA_PURGE_BATCH_SIZE = '2';
    process.env.DATA_PURGE_MAX_BATCHES_PER_TICK = '1';

    [postgresContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = postgresContainer.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    pool = new Pool({ connectionString: postgresContainer.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);

    await app.get(GuidelineIngestService).ingest(yotongGuideline);
    owner = await socialSignUp(app, {
      email: 'issue473-owner@clinic.kr',
      providerId: 'issue473-owner',
      displayName: '배치동결 소유자',
      clinicName: '배치동결 소유 한의원',
      licenseNumber: 'LIC-ISSUE473-OWNER',
    });
  });

  beforeEach(async () => {
    await pool.query(
      'UPDATE conversations SET deleted_at = NULL WHERE deleted_at IS NOT NULL',
    );
    await pool.query('UPDATE patients SET deleted_at = NULL WHERE deleted_at IS NOT NULL');
  });

  afterAll(async () => {
    try {
      await app?.close();
      await pool?.end();
      await postgresContainer?.stop();
      await redisContainer?.stop();
    } finally {
      restoreEnv('DATA_PURGE_ENABLED', previousPurgeEnv.enabled);
      restoreEnv('DATA_PURGE_CRON', previousPurgeEnv.cron);
      restoreEnv('DATA_PURGE_RETENTION_DAYS', previousPurgeEnv.retentionDays);
      restoreEnv('DATA_PURGE_LOCK_TTL_MS', previousPurgeEnv.lockTtlMs);
      restoreEnv('DATA_PURGE_BATCH_SIZE', previousPurgeEnv.batchSize);
      restoreEnv('DATA_PURGE_MAX_BATCHES_PER_TICK', previousPurgeEnv.maxBatchesPerTick);
      restoreEnv('DATABASE_URL', previousPurgeEnv.databaseUrl);
      restoreEnv('REDIS_URL', previousPurgeEnv.redisUrl);
    }
  });

  it('E1: 대화 배치가 꽉 차면 대화가 남은 환자를 건너뛰고 FK 실패 없이 커밋한다', async () => {
    const { patientId, conversationId, unrelatedConversationIds } =
      await createDeferredPatientFixture();

    const purging = app.get(DataPurgeService).purge();
    await expect(purging).resolves.toMatchObject({ patients: 0, conversations: 2 });

    for (const unrelatedId of unrelatedConversationIds) {
      expect(await conversationCount(unrelatedId)).toBe(0);
    }
    expect(await conversationCount(conversationId)).toBe(1);
    expect(await patientCount(patientId)).toBe(1);
    expect(await snapshotCountForPatient(patientId)).toBeGreaterThan(0);
    expect(await guidanceCountForPatient(patientId)).toBeGreaterThan(0);
  });

  it('E2: 첫 틱에서 건너뛴 환자와 남은 대화를 deferred 2건으로 센다', async () => {
    await createDeferredPatientFixture();

    const result = await app.get(DataPurgeService).purge();

    expect(result.deferred).toBe(2);
  });

  it('E3: 두 번째 틱은 대화만 지우고 세 번째 틱은 환자와 스냅샷을 지운다', async () => {
    const { patientId, conversationId } = await createDeferredPatientFixture();
    const subject = app.get(DataPurgeService);

    await subject.purge();
    await subject.purge();

    expect(await conversationCount(conversationId)).toBe(0);
    expect(await patientCount(patientId)).toBe(1);

    const thirdResult = await subject.purge();

    expect(await patientCount(patientId)).toBe(0);
    expect(await snapshotCountForPatient(patientId)).toBe(0);
    expect(thirdResult).toMatchObject({ patients: 1, deferred: 0 });
  });

  it('E4: 대화가 없는 유예 경과 환자는 같은 틱에 지운다', async () => {
    const patient = await createPatient();
    await deletePatient(owner, patient.id);
    await markPatientPastRetention(patient.id, 400);

    const result = await app.get(DataPurgeService).purge();

    expect(await patientCount(patient.id)).toBe(0);
    expect(result.patients).toBe(1);
  });
});
