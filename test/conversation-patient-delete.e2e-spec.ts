// docs/specs/34 수용 기준 1~13, 15~18, 23 동결 테스트 — 구현 중 수정 금지
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
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { DataPurgeService } from '../src/domain/data-purge/service/data-purge.service';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { AesGcmUtil } from '../src/global/security/crypto/aes-gcm.util';
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

interface ConversationChildCounts {
  messages: number;
  citations: number;
  runs: number;
  feedbacks: number;
}

interface GuidanceChildCounts {
  guidances: number;
  reviews: number;
}

const parseSse = (raw: string): SseEvent[] =>
  raw
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => frame.split(/\r?\n/))
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as SseEvent);

describe('docs/specs/34: 대화·환자 삭제와 유예 경과분 파기', () => {
  jest.setTimeout(180_000);

  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let owner: TestSession;
  let otherClinician: TestSession;
  let patientSequence = 0;

  const previousPurgeEnv = {
    enabled: process.env.DATA_PURGE_ENABLED,
    cron: process.env.DATA_PURGE_CRON,
    retentionDays: process.env.DATA_PURGE_RETENTION_DAYS,
    lockTtlMs: process.env.DATA_PURGE_LOCK_TTL_MS,
    batchSize: process.env.DATA_PURGE_BATCH_SIZE,
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
      caseLabel: caseLabel ?? `삭제동결-${String(patientSequence).padStart(3, '0')}`,
      birthYear: 1985,
      sex: 'FEMALE',
      heightCm: 165,
      weightKg: 60,
      waistCm: 76,
      diagnoses: ['합성 진단'],
      medications: ['합성 약물'],
      allergies: [],
      clinicalNotes: 'docs/specs/34 합성 환자 fixture',
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

    expect(response.body).toMatchObject({
      success: true,
      data: null,
      page: null,
    });
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

    expect(response.body).toMatchObject({
      success: true,
      data: null,
      page: null,
    });
  };

  const conversationDeletedAt = async (conversationId: string): Promise<Date | null> => {
    const result = await pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM conversations WHERE id = $1',
      [conversationId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0].deleted_at;
  };

  const patientDeletedAt = async (patientId: string): Promise<Date | null> => {
    const result = await pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM patients WHERE id = $1',
      [patientId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0].deleted_at;
  };

  const conversationDeletedAtText = async (
    conversationId: string,
  ): Promise<string | null> => {
    const result = await pool.query<{ deleted_at: string | null }>(
      'SELECT deleted_at::text AS deleted_at FROM conversations WHERE id = $1',
      [conversationId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0].deleted_at;
  };

  const requireConversationDeletedAt = async (conversationId: string): Promise<Date> => {
    const value = await conversationDeletedAt(conversationId);
    expect(value).not.toBeNull();
    if (value === null) throw new Error('conversations.deleted_at이 NULL이다.');
    return value;
  };

  const requirePatientDeletedAt = async (patientId: string): Promise<Date> => {
    const value = await patientDeletedAt(patientId);
    expect(value).not.toBeNull();
    if (value === null) throw new Error('patients.deleted_at이 NULL이다.');
    return value;
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

  const conversationChildCounts = async (
    conversationId: string,
  ): Promise<ConversationChildCounts> => {
    const result = await pool.query<ConversationChildCounts>(
      `SELECT
         (SELECT count(*)::int
            FROM messages
           WHERE conversation_id = $1) AS messages,
         (SELECT count(*)::int
            FROM message_citations citation
            JOIN messages message ON message.id = citation.message_id
           WHERE message.conversation_id = $1) AS citations,
         (SELECT count(*)::int
            FROM generation_runs run
            JOIN messages message ON message.id = run.message_id
           WHERE message.conversation_id = $1) AS runs,
         (SELECT count(*)::int
            FROM answer_feedbacks feedback
            JOIN messages message ON message.id = feedback.message_id
           WHERE message.conversation_id = $1) AS feedbacks`,
      [conversationId],
    );
    return result.rows[0];
  };

  const guidanceChildCounts = async (
    conversationId: string,
  ): Promise<GuidanceChildCounts> => {
    const result = await pool.query<GuidanceChildCounts>(
      `SELECT
         (SELECT count(*)::int
            FROM clinical_guidances guidance
            JOIN messages message ON message.id = guidance.message_id
           WHERE message.conversation_id = $1) AS guidances,
         (SELECT count(*)::int
            FROM guidance_reviews review
            JOIN clinical_guidances guidance ON guidance.id = review.guidance_id
            JOIN messages message ON message.id = guidance.message_id
           WHERE message.conversation_id = $1) AS reviews`,
      [conversationId],
    );
    return result.rows[0];
  };

  const markConversationPastRetention = async (conversationId: string): Promise<void> => {
    const result = await pool.query(
      `UPDATE conversations
          SET deleted_at = now() - interval '400 days'
        WHERE id = $1`,
      [conversationId],
    );
    expect(result.rowCount).toBe(1);
  };

  const markPatientPastRetention = async (patientId: string): Promise<void> => {
    const result = await pool.query(
      `UPDATE patients
          SET deleted_at = now() - interval '400 days'
        WHERE id = $1`,
      [patientId],
    );
    expect(result.rowCount).toBe(1);
  };

  beforeAll(async () => {
    process.env.DATA_PURGE_ENABLED = 'false';
    process.env.DATA_PURGE_CRON = '0 0 1 1 *';
    process.env.DATA_PURGE_RETENTION_DAYS = '30';
    process.env.DATA_PURGE_LOCK_TTL_MS = '60000';
    process.env.DATA_PURGE_BATCH_SIZE = '200';

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
      email: 'spec34-owner@clinic.kr',
      providerId: 'spec34-owner',
      displayName: '삭제동결 소유자',
      clinicName: '삭제동결 소유 한의원',
      licenseNumber: 'LIC-SPEC34-OWNER',
    });
    otherClinician = await socialSignUp(app, {
      email: 'spec34-other@clinic.kr',
      providerId: 'spec34-other',
      displayName: '삭제동결 타 의료인',
      clinicName: '삭제동결 타 한의원',
      licenseNumber: 'LIC-SPEC34-OTHER',
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await postgresContainer?.stop();
    await redisContainer?.stop();

    restoreEnv('DATA_PURGE_ENABLED', previousPurgeEnv.enabled);
    restoreEnv('DATA_PURGE_CRON', previousPurgeEnv.cron);
    restoreEnv('DATA_PURGE_RETENTION_DAYS', previousPurgeEnv.retentionDays);
    restoreEnv('DATA_PURGE_LOCK_TTL_MS', previousPurgeEnv.lockTtlMs);
    restoreEnv('DATA_PURGE_BATCH_SIZE', previousPurgeEnv.batchSize);
  });

  it('기준 1: 대화 DELETE는 200 + null 봉투이고 deleted_at을 채운다', async () => {
    const conversationId = await createConversation();

    await deleteConversation(owner, conversationId);

    expect(await conversationDeletedAt(conversationId)).not.toBeNull();
  });

  it('기준 2: 삭제된 대화는 대화 목록에서 사라진다', async () => {
    const title = `목록에서 숨길 삭제 대화 ${ulid()}`;
    const conversationId = await createConversation({ title });
    await deleteConversation(owner, conversationId);
    await requireConversationDeletedAt(conversationId);

    const response = await request(server())
      .get('/api/v1/conversations')
      .query({ size: 50 })
      .set('Cookie', owner.cookie)
      .expect(200);

    expect((response.body.data as Array<{ id: string }>).map((item) => item.id)).not.toContain(
      conversationId,
    );
  });

  it('기준 3: 삭제된 대화의 상세 조회는 404 NOT_FOUND다', async () => {
    const conversationId = await createConversation();
    await deleteConversation(owner, conversationId);
    await requireConversationDeletedAt(conversationId);

    const response = await request(server())
      .get(`/api/v1/conversations/${conversationId}`)
      .set('Cookie', owner.cookie)
      .expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('기준 4: 삭제된 대화의 메시지 목록 조회는 404다', async () => {
    const conversationId = await createConversation();
    await deleteConversation(owner, conversationId);
    await requireConversationDeletedAt(conversationId);

    const response = await request(server())
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set('Cookie', owner.cookie)
      .expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('기준 5: 삭제된 대화에는 메시지 스트림을 시작할 수 없다', async () => {
    const conversationId = await createConversation();
    await deleteConversation(owner, conversationId);
    await requireConversationDeletedAt(conversationId);

    const response = await request(server())
      .post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .send({ content: GUIDELINE_QUESTION, clientRequestId: randomUUID() })
      .expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('기준 6: 대화 DELETE 재시도는 200이고 최초 deleted_at을 덮지 않는다', async () => {
    const conversationId = await createConversation();
    await deleteConversation(owner, conversationId);
    const firstDeletedAt = await conversationDeletedAtText(conversationId);
    expect(firstDeletedAt).toEqual(expect.any(String));

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await deleteConversation(owner, conversationId);
    const retriedDeletedAt = await conversationDeletedAtText(conversationId);

    expect(retriedDeletedAt).toBe(firstDeletedAt);
  });

  it('기준 7: 다른 의료인의 대화 DELETE는 404이고 그 행을 변경하지 않는다', async () => {
    // 양성 대조군이 있어 라우트 미구현 404나 전면 no-op가 이 테스트를 통과할 수 없다.
    const ownedControl = await createConversation();
    await deleteConversation(owner, ownedControl);
    await requireConversationDeletedAt(ownedControl);

    const foreignConversationId = await createConversation({ session: otherClinician });
    const response = await request(server())
      .delete(`/api/v1/conversations/${foreignConversationId}`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
    expect(await conversationDeletedAt(foreignConversationId)).toBeNull();
  });

  it('기준 8: 환자 DELETE는 200 + null 봉투이고 patients.deleted_at을 채운다', async () => {
    const patient = await createPatient();

    await deletePatient(owner, patient.id);

    expect(await patientDeletedAt(patient.id)).not.toBeNull();
  });

  it('기준 9: 환자 삭제는 그 환자의 PATIENT_GUIDANCE 대화도 소프트 삭제한다', async () => {
    const patient = await createPatient();
    const conversationId = await createConversation({
      type: 'PATIENT_GUIDANCE',
      patientId: patient.id,
    });

    await deletePatient(owner, patient.id);
    await requirePatientDeletedAt(patient.id);

    expect(await conversationDeletedAt(conversationId)).not.toBeNull();
  });

  it('기준 10: 환자 삭제는 먼저 삭제된 대화의 deleted_at을 덮지 않는다', async () => {
    const patient = await createPatient();
    const conversationId = await createConversation({
      type: 'PATIENT_GUIDANCE',
      patientId: patient.id,
    });

    await deleteConversation(owner, conversationId);
    const firstDeletedAt = await conversationDeletedAtText(conversationId);
    expect(firstDeletedAt).toEqual(expect.any(String));

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await deletePatient(owner, patient.id);
    await requirePatientDeletedAt(patient.id);

    expect(await conversationDeletedAtText(conversationId)).toBe(firstDeletedAt);
  });

  it('기준 11: 삭제된 환자는 환자 목록에서 사라진다', async () => {
    const caseLabel = `목록에서 숨길 삭제 환자 ${ulid()}`;
    const patient = await createPatient(owner, caseLabel);
    await deletePatient(owner, patient.id);
    await requirePatientDeletedAt(patient.id);

    const response = await request(server())
      .get('/api/v1/patients')
      .query({ query: caseLabel, size: 50 })
      .set('Cookie', owner.cookie)
      .expect(200);

    expect((response.body.data as Array<{ id: string }>).map((item) => item.id)).not.toContain(
      patient.id,
    );
  });

  it('기준 12: 삭제된 환자의 상세 조회는 404 NOT_FOUND다', async () => {
    const patient = await createPatient();
    await deletePatient(owner, patient.id);
    await requirePatientDeletedAt(patient.id);

    const response = await request(server())
      .get(`/api/v1/patients/${patient.id}`)
      .set('Cookie', owner.cookie)
      .expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('기준 13: 삭제된 대화에 딸린 임상 가이던스 조회는 404다', async () => {
    const patient = await createPatient();
    const conversationId = await createConversation({
      type: 'PATIENT_GUIDANCE',
      patientId: patient.id,
    });
    const completed = await streamCompleted(owner, conversationId, PATIENT_GUIDANCE_QUESTION);
    const guidanceId = completed.guidance?.id;
    expect(guidanceId).toEqual(expect.any(String));
    if (!guidanceId) throw new Error('합성 임상 가이던스 id가 없습니다.');

    await deleteConversation(owner, conversationId);
    await requireConversationDeletedAt(conversationId);

    const response = await request(server())
      .get(`/api/v1/clinical-guidance/${guidanceId}`)
      .set('Cookie', owner.cookie)
      .expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('기준 15: 대화 퍼지는 messages·citations·runs·feedbacks를 각각 0건으로 만든다', async () => {
    const conversationId = await createConversation();
    const completed = await streamCompleted(owner, conversationId);
    const assistantMessageId = completed.message?.id;
    expect(assistantMessageId).toEqual(expect.any(String));
    if (!assistantMessageId) throw new Error('합성 답변 메시지 id가 없습니다.');

    await request(server())
      .post(`/api/v1/messages/${assistantMessageId}/feedback`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .send({ rating: 'HELPFUL', comment: '퍼지 fixture 피드백' })
      .expect(200);

    const before = await conversationChildCounts(conversationId);
    expect(before.messages).toBeGreaterThan(0);
    expect(before.citations).toBeGreaterThan(0);
    expect(before.runs).toBeGreaterThan(0);
    expect(before.feedbacks).toBeGreaterThan(0);

    await markConversationPastRetention(conversationId);
    await app.get(DataPurgeService).purge();

    const after = await conversationChildCounts(conversationId);
    expect(after.messages).toBe(0);
    expect(after.citations).toBe(0);
    expect(after.runs).toBe(0);
    expect(after.feedbacks).toBe(0);
    expect(await conversationCount(conversationId)).toBe(0);
  });

  it('기준 16: 대화 퍼지는 clinical_guidances·guidance_reviews를 각각 0건으로 만든다', async () => {
    const patient = await createPatient();
    const conversationId = await createConversation({
      type: 'PATIENT_GUIDANCE',
      patientId: patient.id,
    });
    const completed = await streamCompleted(owner, conversationId, PATIENT_GUIDANCE_QUESTION);
    const guidanceId = completed.guidance?.id;
    expect(guidanceId).toEqual(expect.any(String));
    if (!guidanceId) throw new Error('합성 임상 가이던스 id가 없습니다.');

    await request(server())
      .post(`/api/v1/clinical-guidance/${guidanceId}/reviews`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .send({ decision: 'ACCEPTED', note: '퍼지 fixture 검토' })
      .expect(200);

    const before = await guidanceChildCounts(conversationId);
    expect(before.guidances).toBeGreaterThan(0);
    expect(before.reviews).toBeGreaterThan(0);

    await markConversationPastRetention(conversationId);
    await app.get(DataPurgeService).purge();

    const after = await guidanceChildCounts(conversationId);
    expect(after.guidances).toBe(0);
    expect(after.reviews).toBe(0);
    expect(await conversationCount(conversationId)).toBe(0);
  });

  it('기준 17: 환자 퍼지는 가이던스가 참조하지 않는 합성 고아 스냅샷과 환자를 지운다', async () => {
    const patient = await createPatient();
    const orphanSnapshotId = ulid();
    const encryptedPayload = app.get(AesGcmUtil).encrypt(
      JSON.stringify({
        caseLabel: patient.caseLabel,
        synthetic: true,
        reason: '가이던스 생성 직전 실패를 모방한 고아 스냅샷',
      }),
    );

    await pool.query(
      `INSERT INTO patient_profile_snapshots
         (id, patient_id, clinic_id, payload_encrypted)
       VALUES ($1, $2, $3, $4)`,
      [orphanSnapshotId, patient.id, owner.clinicId, encryptedPayload],
    );

    expect(await snapshotCountForPatient(patient.id)).toBe(1);
    expect(
      await countRows(
        `SELECT count(*)::int AS count
           FROM clinical_guidances
          WHERE patient_snapshot_id = $1`,
        [orphanSnapshotId],
      ),
    ).toBe(0);
    expect(await patientCount(patient.id)).toBe(1);

    await markPatientPastRetention(patient.id);
    await app.get(DataPurgeService).purge();

    expect(await snapshotCountForPatient(patient.id)).toBe(0);
    expect(await patientCount(patient.id)).toBe(0);
  });

  it('기준 18: 양성 퍼지 대조군은 지우되 삭제되지 않은 대화·환자는 보존한다', async () => {
    const liveConversationId = await createConversation();
    const livePatient = await createPatient();
    const purgeableConversationId = await createConversation();
    const purgeablePatient = await createPatient();

    await markConversationPastRetention(purgeableConversationId);
    await markPatientPastRetention(purgeablePatient.id);

    expect(await conversationCount(liveConversationId)).toBe(1);
    expect(await patientCount(livePatient.id)).toBe(1);
    expect(await conversationCount(purgeableConversationId)).toBe(1);
    expect(await patientCount(purgeablePatient.id)).toBe(1);

    await app.get(DataPurgeService).purge();

    // 이 양성 대조가 no-op 스텁의 우연한 통과를 막는다.
    expect(await conversationCount(purgeableConversationId)).toBe(0);
    expect(await patientCount(purgeablePatient.id)).toBe(0);
    expect(await conversationCount(liveConversationId)).toBe(1);
    expect(await patientCount(livePatient.id)).toBe(1);
  });

  it('기준 23-1: ARCHIVED 대화도 409가 아니라 200으로 삭제되고 deleted_at이 채워진다', async () => {
    const conversationId = await createConversation();
    await request(server())
      .post(`/api/v1/conversations/${conversationId}/archive`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .expect(200);

    const archived = await pool.query<{ status: string }>(
      'SELECT status FROM conversations WHERE id = $1',
      [conversationId],
    );
    expect(archived.rows).toEqual([{ status: 'ARCHIVED' }]);

    await deleteConversation(owner, conversationId);
    expect(await conversationDeletedAt(conversationId)).not.toBeNull();
  });

  it('기준 23-2: ARCHIVED 환자도 PATIENT_ARCHIVED 409가 아니라 200으로 삭제된다', async () => {
    const patient = await createPatient();
    await request(server())
      .post(`/api/v1/patients/${patient.id}/archive`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .expect(200);

    const archived = await pool.query<{ status: string }>(
      'SELECT status FROM patients WHERE id = $1',
      [patient.id],
    );
    expect(archived.rows).toEqual([{ status: 'ARCHIVED' }]);

    await deletePatient(owner, patient.id);
    expect(await patientDeletedAt(patient.id)).not.toBeNull();
  });
});
