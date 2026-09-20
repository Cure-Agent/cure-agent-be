// 이슈 #497 수용 기준 동결 테스트 — 구현 중 수정 금지
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
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { socialSignUp, type TestSession } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };

interface PatientDto {
  id: string;
  caseLabel: string;
}

interface Turn {
  conversationId: string;
  assistantMessageId: string;
}

describe('이슈 #497: 에이전트 턴이 남은 환자 보류와 틱별 파기', () => {
  jest.setTimeout(180_000);

  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let owner: TestSession;
  let patientSequence = 0;
  const previousEnv = new Map<string, string | undefined>();

  const server = () => app.getHttpServer();

  const createPatient = async (): Promise<PatientDto> => {
    patientSequence += 1;
    const body = {
      caseLabel: `턴보류동결-${String(patientSequence).padStart(3, '0')}`,
      birthYear: 1985,
      sex: 'FEMALE',
      heightCm: 165,
      weightKg: 60,
      waistCm: 76,
      diagnoses: ['합성 진단'],
      medications: ['합성 약물'],
      allergies: [],
      clinicalNotes: '이슈 #497 합성 환자 fixture',
    };
    const response = await request(server())
      .post('/api/v1/patients')
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .send(body)
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      data: { id: expect.any(String), caseLabel: body.caseLabel },
    });
    return response.body.data as PatientDto;
  };

  const createConversation = async (): Promise<string> => {
    const response = await request(server())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .send({ type: 'GUIDELINE_QA' })
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      data: { id: expect.any(String), type: 'GUIDELINE_QA' },
    });
    return response.body.data.id as string;
  };

  const deleteConversation = async (conversationId: string): Promise<void> => {
    const response = await request(server())
      .delete(`/api/v1/conversations/${conversationId}`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(response.body).toMatchObject({ success: true, data: null, page: null });
  };

  const deletePatient = async (patientId: string): Promise<void> => {
    const response = await request(server())
      .delete(`/api/v1/patients/${patientId}`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(response.body).toMatchObject({ success: true, data: null, page: null });
  };

  const accept = async (): Promise<Turn> => {
    const conversationId = await createConversation();
    const response = await request(server())
      .post(`/api/v1/internal/agent/conversations/${conversationId}/turns`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .send({ content: '합성 환자의 기록을 확인해 주세요.', clientRequestId: randomUUID() })
      .expect(201);
    expect(response.body).toMatchObject({
      success: true,
      data: { assistantMessageId: expect.any(String), userMessageId: expect.any(String) },
    });
    return {
      conversationId,
      assistantMessageId: response.body.data.assistantMessageId as string,
    };
  };

  const resolvePatient = async (turn: Turn, patient: PatientDto): Promise<void> => {
    const response = await request(server())
      .post(`/api/v1/internal/agent/turns/${turn.assistantMessageId}/patient`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .send({ caseLabel: patient.caseLabel })
      .expect(200);
    expect(response.body).toMatchObject({
      success: true,
      data: { outcome: 'RESOLVED', patient: { id: patient.id } },
    });
  };

  const countRows = async (sql: string, values: unknown[]): Promise<number> => {
    const result = await pool.query<{ count: number }>(sql, values);
    const row = result.rows[0];
    if (!row) throw new Error('행 개수 조회 결과가 없습니다.');
    return row.count;
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

  const turnRows = async (turn: Turn) => {
    // messages와 JOIN하지 않는다: 턴 자체의 잔존 여부와 스냅샷 참조를 관측한다.
    const result = await pool.query<{ patient_snapshot_id: string | null }>(
      'SELECT patient_snapshot_id FROM agent_turns WHERE message_id = $1',
      [turn.assistantMessageId],
    );
    return result.rows;
  };

  const conversationState = async (conversationId: string) => {
    const result = await pool.query<{
      patient_id: string | null;
      deleted_at: Date | null;
    }>('SELECT patient_id, deleted_at FROM conversations WHERE id = $1', [conversationId]);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    if (!row) throw new Error('대화 행을 찾지 못했습니다.');
    return row;
  };

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
      await deleteConversation(conversationId);
      await markConversationPastRetention(conversationId, 400);
    }

    const patient = await createPatient();
    const turn = await accept();
    await resolvePatient(turn, patient);

    // patient_id 갈래로 보류되는 픽스처는 #497의 누락을 드러내지 못한다.
    expect((await conversationState(turn.conversationId)).patient_id).toBeNull();
    const pinnedTurns = await turnRows(turn);
    expect(pinnedTurns).toHaveLength(1);
    const pinnedTurn = pinnedTurns[0];
    if (!pinnedTurn) throw new Error('수락한 에이전트 턴이 없습니다.');
    expect(pinnedTurn.patient_snapshot_id).toEqual(expect.any(String));
    const pinnedSnapshot = await pool.query<{ patient_id: string }>(
      'SELECT patient_id FROM patient_profile_snapshots WHERE id = $1',
      [pinnedTurn.patient_snapshot_id],
    );
    expect(pinnedSnapshot.rows).toEqual([{ patient_id: patient.id }]);

    await deletePatient(patient.id);
    // 직접 날짜를 조정하기 전에 공개 DELETE의 에이전트 대화 연쇄를 확인한다.
    expect((await conversationState(turn.conversationId)).deleted_at).not.toBeNull();
    await markPatientPastRetention(patient.id, 399);
    await markConversationPastRetention(turn.conversationId, 399);

    return { patientId: patient.id, turn, unrelatedConversationIds };
  };

  beforeAll(async () => {
    const settings: Record<string, string> = {
      DATA_PURGE_ENABLED: 'false',
      DATA_PURGE_CRON: '0 0 1 1 *',
      DATA_PURGE_RETENTION_DAYS: '30',
      DATA_PURGE_LOCK_TTL_MS: '60000',
      DATA_PURGE_BATCH_SIZE: '2',
      DATA_PURGE_MAX_BATCHES_PER_TICK: '1',
    };
    for (const key of [...Object.keys(settings), 'DATABASE_URL', 'REDIS_URL']) {
      previousEnv.set(key, process.env[key]);
    }
    Object.assign(process.env, settings);

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
    owner = await socialSignUp(app, {
      email: 'issue497-owner@clinic.kr',
      providerId: 'issue497-owner',
      displayName: '턴보류동결 소유자',
      clinicName: '턴보류동결 소유 한의원',
      licenseNumber: 'LIC-ISSUE497-OWNER',
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
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('기준 1-1~1-8: 밀린 에이전트 턴의 환자를 보류하고 무관한 대화는 커밋한다', async () => {
    const { patientId, turn, unrelatedConversationIds } =
      await createDeferredPatientFixture();

    const purging = app.get(DataPurgeService).purge();
    // 1-1: FK 예외 없이 실제 파기 틱을 마친다.
    await expect(purging).resolves.toMatchObject({ skipped: false });
    const result = await purging;
    expect(result.patients).toBe(0); // 1-2
    expect(result.conversations).toBe(2); // 1-3
    for (const unrelatedId of unrelatedConversationIds) {
      expect(await conversationCount(unrelatedId)).toBe(0); // 1-4: 각각 확인
    }
    expect(await patientCount(patientId)).toBe(1); // 1-5
    expect(await snapshotCountForPatient(patientId)).toBeGreaterThan(0); // 1-6
    expect(await conversationCount(turn.conversationId)).toBe(1); // 1-7
    const remainingTurns = await turnRows(turn);
    expect(remainingTurns).toHaveLength(1); // 1-8: 턴 잔존
    const remainingTurn = remainingTurns[0];
    if (!remainingTurn) throw new Error('보류한 에이전트 턴이 사라졌습니다.');
    expect(remainingTurn.patient_snapshot_id).not.toBeNull(); // 1-8: 참조 유지
  });

  it('기준 2-1: 첫 틱의 보류 환자와 남은 에이전트 대화를 deferred로 센다', async () => {
    await createDeferredPatientFixture();

    const result = await app.get(DataPurgeService).purge();

    expect(result.deferred).toBe(2); // 2-1
  });

  it('기준 3-1~3-5: 두 번째 틱은 대화만, 세 번째 틱은 환자와 스냅샷을 지운다', async () => {
    const { patientId, turn } = await createDeferredPatientFixture();
    const subject = app.get(DataPurgeService);

    await subject.purge();
    await subject.purge();

    expect(await conversationCount(turn.conversationId)).toBe(0); // 3-1
    expect(await patientCount(patientId)).toBe(1); // 3-2

    const thirdResult = await subject.purge();

    expect(await patientCount(patientId)).toBe(0); // 3-3
    expect(await snapshotCountForPatient(patientId)).toBe(0); // 3-4
    expect(thirdResult.patients).toBe(1); // 3-5: 환자 파기 수
    expect(thirdResult.deferred).toBe(0); // 3-5: 보류 해소
  });

  it('기준 4-1~4-2: 같은 틱에서 참조 없는 Q는 지우고 턴이 참조하는 P만 남긴다', async () => {
    const { patientId: patientPId } = await createDeferredPatientFixture();
    const patientQ = await createPatient();
    const unpinnedTurn = await accept();
    expect(await turnRows(unpinnedTurn)).toEqual([{ patient_snapshot_id: null }]);
    expect(await snapshotCountForPatient(patientQ.id)).toBe(0);

    await deletePatient(patientQ.id);
    await markPatientPastRetention(patientQ.id, 399);
    expect((await conversationState(unpinnedTurn.conversationId)).deleted_at).toBeNull();

    // Q만 보는 음성 대조는 기존 코드에서도 통과할 수 있어 P를 함께 관측한다.
    const purging = app.get(DataPurgeService).purge();
    await expect(purging).resolves.toMatchObject({ skipped: false });

    expect(await patientCount(patientQ.id)).toBe(0); // 4-1
    expect(await patientCount(patientPId)).toBe(1); // 4-2: 같은 틱의 양성 대조
  });
});
