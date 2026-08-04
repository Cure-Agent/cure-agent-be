// docs/specs/39 수용 기준 1~4, 6~14, 24~25 동결 테스트 — 구현 중 수정 금지
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request, { Response as SupertestResponse } from 'supertest';
import { AppModule } from '../src/app.module';
import { DataPurgeService } from '../src/domain/data-purge/service/data-purge.service';
import { RealTimeAlertSender } from '../src/global/observability/real-time-alert.sender';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import {
  joinByInvitation,
  setCookies,
  socialCallback,
  type SocialIdentity,
  type TestSession,
} from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const SESSION_RETENTION_DAYS = 30;

interface FullSession extends TestSession {
  refreshCookie: string;
}

interface AuthSessionRow {
  id: string;
  clinician_id: string;
  family_id: string;
  expires_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
  reuse_detected_at: Date | null;
}

interface RotationFixture {
  oldSessionId: string;
  familyId: string;
  oldRefreshCookie: string;
  newRefreshCookie: string;
}

describe('docs/specs/39: refresh 세션 보존 정책', () => {
  jest.setTimeout(300_000);

  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let fixtureSequence = 0;

  const alertSender = { send: jest.fn() };
  const previousPurgeEnv = {
    enabled: process.env.DATA_PURGE_ENABLED,
    cron: process.env.DATA_PURGE_CRON,
    retentionDays: process.env.DATA_PURGE_RETENTION_DAYS,
    sessionRetentionDays: process.env.DATA_PURGE_SESSION_RETENTION_DAYS,
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

  const nextIdentity = (label: string): SocialIdentity => {
    fixtureSequence += 1;
    return {
      email: `spec39-${label}-${fixtureSequence}@example.test`,
      provider: 'GOOGLE',
      providerId: `spec39-${label}-${fixtureSequence}`,
      displayName: `세션보존 ${label}`,
    };
  };

  const requiredCookie = (
    response: SupertestResponse,
    name: 'access_token' | 'refresh_token',
  ): string => {
    const raw = setCookies(response)[name];
    if (!raw) throw new Error(`응답에 ${name} 쿠키가 없습니다.`);
    return raw.split(';')[0];
  };

  /** auth_sessions 행은 이 실제 OAuth 가입 경로로만 만든다. */
  const createAccount = async (label: string): Promise<FullSession> => {
    const identity = nextIdentity(label);
    const { ticket } = await socialCallback(app, identity);
    if (!ticket) throw new Error(`신규 가입 티켓을 받지 못했습니다. (${identity.email})`);

    const response = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        ticket,
        displayName: identity.displayName,
        clinicName: `세션보존 ${label} 한의원 ${fixtureSequence}`,
        licenseNumber: `LIC-SPEC39-${fixtureSequence}`,
        termsAccepted: true,
      })
      .expect(201);

    return {
      cookie: requiredCookie(response, 'access_token'),
      refreshCookie: requiredCookie(response, 'refresh_token'),
      clinicianId: response.body.data.clinician.id as string,
      clinicId: response.body.data.clinician.clinic.id as string,
    };
  };

  const authSessionsOf = async (clinicianId: string): Promise<AuthSessionRow[]> => {
    const result = await pool.query<AuthSessionRow>(
      `SELECT id,
              clinician_id,
              family_id,
              expires_at,
              rotated_at,
              revoked_at,
              reuse_detected_at
         FROM auth_sessions
        WHERE clinician_id = $1
        ORDER BY created_at, id`,
      [clinicianId],
    );
    return result.rows;
  };

  const onlySessionOf = async (clinicianId: string): Promise<AuthSessionRow> => {
    const rows = await authSessionsOf(clinicianId);
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  const sessionCountById = async (sessionId: string): Promise<number> => {
    const result = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM auth_sessions WHERE id = $1',
      [sessionId],
    );
    return result.rows[0].count;
  };

  const sessionCountForClinician = async (clinicianId: string): Promise<number> => {
    const result = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM auth_sessions WHERE clinician_id = $1',
      [clinicianId],
    );
    return result.rows[0].count;
  };

  const clinicianCount = async (clinicianId: string): Promise<number> => {
    const result = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM clinicians WHERE id = $1',
      [clinicianId],
    );
    return result.rows[0].count;
  };

  /** 세션 fixture에서 허용된 유일한 DB 상태 조작: expires_at만 과거로 옮긴다. */
  const markSessionExpiredDaysAgo = async (
    sessionId: string,
    daysAgo: number,
  ): Promise<void> => {
    const result = await pool.query(
      `UPDATE auth_sessions
          SET expires_at = now() - ($2::int * interval '1 day')
        WHERE id = $1`,
      [sessionId, daysAgo],
    );
    expect(result.rowCount).toBe(1);
  };

  const markAllClinicianSessionsPastRetention = async (
    clinicianId: string,
  ): Promise<void> => {
    const result = await pool.query(
      `UPDATE auth_sessions
          SET expires_at = now() - interval '31 days'
        WHERE clinician_id = $1`,
      [clinicianId],
    );
    expect(result.rowCount).toBeGreaterThan(0);
  };

  const createDoomedControl = async (label: string): Promise<string> => {
    const account = await createAccount(`${label}-삭제대조`);
    const session = await onlySessionOf(account.clinicianId);
    await markSessionExpiredDaysAgo(session.id, SESSION_RETENTION_DAYS + 1);
    return session.id;
  };

  /** rotated_at은 직접 쓰지 않고 실제 refresh 요청으로 회전분과 원문 구 쿠키를 만든다. */
  const rotate = async (account: FullSession): Promise<RotationFixture> => {
    const oldSession = await onlySessionOf(account.clinicianId);
    const response = await request(server())
      .post('/api/v1/auth/refresh')
      .set(CSRF)
      .set('Cookie', account.refreshCookie)
      .expect(200);
    const newRefreshCookie = requiredCookie(response, 'refresh_token');
    expect(newRefreshCookie).not.toBe(account.refreshCookie);

    const rows = await authSessionsOf(account.clinicianId);
    const rotated = rows.find((row) => row.id === oldSession.id);
    expect(rotated?.rotated_at).not.toBeNull();
    expect(rows.some((row) => row.id !== oldSession.id)).toBe(true);

    return {
      oldSessionId: oldSession.id,
      familyId: oldSession.family_id,
      oldRefreshCookie: account.refreshCookie,
      newRefreshCookie,
    };
  };

  const withdraw = async (account: FullSession): Promise<void> => {
    await request(server())
      .delete('/api/v1/auth/me')
      .set(CSRF)
      .set('Cookie', [account.cookie, account.refreshCookie])
      .expect(200);
  };

  const createPatient = async (account: TestSession, label: string): Promise<string> => {
    const response = await request(server())
      .post('/api/v1/patients')
      .set(CSRF)
      .set('Cookie', account.cookie)
      .send({
        caseLabel: `세션축 회귀 ${label}`,
        birthYear: 1985,
        sex: 'FEMALE',
        heightCm: 165,
        weightKg: 60,
        waistCm: 76,
        diagnoses: ['합성 진단'],
        medications: ['합성 약물'],
        allergies: [],
        clinicalNotes: 'docs/specs/39 기준 24 합성 환자 fixture',
      })
      .expect(201);
    return response.body.data.id as string;
  };

  const createConversation = async (account: TestSession): Promise<string> => {
    const response = await request(server())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', account.cookie)
      .send({ type: 'GUIDELINE_QA', title: `세션축 회귀 대화 ${fixtureSequence}` })
      .expect(201);
    return response.body.data.id as string;
  };

  const rowCount = async (table: 'conversations' | 'patients', id: string): Promise<number> => {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table} WHERE id = $1`,
      [id],
    );
    return result.rows[0].count;
  };

  beforeAll(async () => {
    process.env.DATA_PURGE_ENABLED = 'false';
    process.env.DATA_PURGE_CRON = '0 0 1 1 *';
    process.env.DATA_PURGE_RETENTION_DAYS = '30';
    process.env.DATA_PURGE_SESSION_RETENTION_DAYS = String(SESSION_RETENTION_DAYS);
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
      .overrideProvider(RealTimeAlertSender)
      .useValue(alertSender)
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      // signup은 60초당 20회로 제한되지만 이 스위트는 기준마다 계정과 삭제 대조군을 새로 만들어
      // 수십 회 가입한다. 가입 폭주 방어는 docs/specs/39의 검증 대상이 아니므로 이 스위트에서만
      // 무력화한다 (clinic-member-removal·clinician-withdrawal·social-account-signup 선례).
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await postgresContainer?.stop();
    await redisContainer?.stop();

    restoreEnv('DATA_PURGE_ENABLED', previousPurgeEnv.enabled);
    restoreEnv('DATA_PURGE_CRON', previousPurgeEnv.cron);
    restoreEnv('DATA_PURGE_RETENTION_DAYS', previousPurgeEnv.retentionDays);
    restoreEnv(
      'DATA_PURGE_SESSION_RETENTION_DAYS',
      previousPurgeEnv.sessionRetentionDays,
    );
    restoreEnv('DATA_PURGE_LOCK_TTL_MS', previousPurgeEnv.lockTtlMs);
    restoreEnv('DATA_PURGE_BATCH_SIZE', previousPurgeEnv.batchSize);
  });

  beforeEach(() => {
    alertSender.send.mockClear();
  });

  it('기준 1: 만료 후 유예가 지난 세션은 purge() 뒤 물리 삭제된다', async () => {
    const account = await createAccount('기준1');
    const expired = await onlySessionOf(account.clinicianId);
    await markSessionExpiredDaysAgo(expired.id, SESSION_RETENTION_DAYS + 1);
    expect(await sessionCountById(expired.id)).toBe(1);

    await app.get(DataPurgeService).purge();

    expect(await sessionCountById(expired.id)).toBe(0);
  });

  it('기준 2: 만료됐어도 유예 미경과 세션은 남는다', async () => {
    const account = await createAccount('기준2');
    const survivor = await onlySessionOf(account.clinicianId);
    await markSessionExpiredDaysAgo(survivor.id, 1);
    const doomedId = await createDoomedControl('기준2');

    await app.get(DataPurgeService).purge();

    expect(await sessionCountById(survivor.id)).toBe(1);
    expect(await sessionCountById(doomedId)).toBe(0);
  });

  it('기준 3: 아직 만료되지 않은 살아 있는 세션은 남는다', async () => {
    const account = await createAccount('기준3');
    const survivor = await onlySessionOf(account.clinicianId);
    expect(survivor.expires_at.getTime()).toBeGreaterThan(Date.now());
    const doomedId = await createDoomedControl('기준3');

    await app.get(DataPurgeService).purge();

    expect(await sessionCountById(survivor.id)).toBe(1);
    expect(await sessionCountById(doomedId)).toBe(0);
  });

  it('기준 4: 세션 파기는 소유자 clinicians 행을 지우지 않는다', async () => {
    const account = await createAccount('기준4');
    const expired = await onlySessionOf(account.clinicianId);
    await markSessionExpiredDaysAgo(expired.id, SESSION_RETENTION_DAYS + 1);
    expect(await clinicianCount(account.clinicianId)).toBe(1);

    await app.get(DataPurgeService).purge();

    expect(await sessionCountById(expired.id)).toBe(0);
    expect(await clinicianCount(account.clinicianId)).toBe(1);
  });

  it('기준 6: revoked_at 세션도 만료 후 유예 전에는 남는다', async () => {
    const account = await createAccount('기준6');
    const survivor = await onlySessionOf(account.clinicianId);
    await request(server())
      .post('/api/v1/auth/logout')
      .set(CSRF)
      .set('Cookie', [account.cookie, account.refreshCookie])
      .expect(200);
    const revoked = (await authSessionsOf(account.clinicianId)).find(
      (row) => row.id === survivor.id,
    );
    expect(revoked?.revoked_at).not.toBeNull();
    await markSessionExpiredDaysAgo(survivor.id, 1);
    const doomedId = await createDoomedControl('기준6');

    await app.get(DataPurgeService).purge();

    expect(await sessionCountById(survivor.id)).toBe(1);
    expect(await sessionCountById(doomedId)).toBe(0);
  });

  it('기준 7: rotated_at 세션도 만료 후 유예 전에는 남는다', async () => {
    const account = await createAccount('기준7');
    const rotation = await rotate(account);
    await markSessionExpiredDaysAgo(rotation.oldSessionId, 1);
    const doomedId = await createDoomedControl('기준7');

    await app.get(DataPurgeService).purge();

    expect(await sessionCountById(rotation.oldSessionId)).toBe(1);
    expect(await sessionCountById(doomedId)).toBe(0);
  });

  it('기준 8: reuse_detected_at 세션도 유예 경과 시 예외 없이 지워진다', async () => {
    const account = await createAccount('기준8');
    const rotation = await rotate(account);
    const replay = await request(server())
      .post('/api/v1/auth/refresh')
      .set(CSRF)
      .set('Cookie', rotation.oldRefreshCookie)
      .expect(401);
    expect(replay.body.code).toBe('AUTH_REFRESH_REUSED');
    const reused = (await authSessionsOf(account.clinicianId)).find(
      (row) => row.id === rotation.oldSessionId,
    );
    expect(reused?.reuse_detected_at).not.toBeNull();
    await markSessionExpiredDaysAgo(
      rotation.oldSessionId,
      SESSION_RETENTION_DAYS + 1,
    );

    await app.get(DataPurgeService).purge();

    expect(await sessionCountById(rotation.oldSessionId)).toBe(0);
  });

  it('기준 9: 유예 미경과 회전분의 구 쿠키 재사용은 AUTH_REFRESH_REUSED다', async () => {
    const account = await createAccount('기준9');
    const rotation = await rotate(account);
    await markSessionExpiredDaysAgo(rotation.oldSessionId, 1);
    const doomedId = await createDoomedControl('기준9');

    await app.get(DataPurgeService).purge();
    expect(await sessionCountById(rotation.oldSessionId)).toBe(1);
    expect(await sessionCountById(doomedId)).toBe(0);

    const response = await request(server())
      .post('/api/v1/auth/refresh')
      .set(CSRF)
      .set('Cookie', rotation.oldRefreshCookie)
      .expect(401);
    expect(response.body.code).toBe('AUTH_REFRESH_REUSED');
  });

  it('기준 10: 유예 중 구 쿠키 재사용은 같은 family 세션을 전부 폐기한다', async () => {
    const account = await createAccount('기준10');
    const rotation = await rotate(account);
    await markSessionExpiredDaysAgo(rotation.oldSessionId, 1);
    const doomedId = await createDoomedControl('기준10');

    await app.get(DataPurgeService).purge();
    expect(await sessionCountById(doomedId)).toBe(0);

    await request(server())
      .post('/api/v1/auth/refresh')
      .set(CSRF)
      .set('Cookie', rotation.oldRefreshCookie)
      .expect(401);

    const family = await pool.query<{ total: number; revoked: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked
         FROM auth_sessions
        WHERE family_id = $1`,
      [rotation.familyId],
    );
    expect(family.rows[0].total).toBeGreaterThan(0);
    expect(family.rows[0].revoked).toBe(family.rows[0].total);
  });

  it('기준 11: 유예 경과로 파기된 구 쿠키 재사용은 UNAUTHORIZED다', async () => {
    const account = await createAccount('기준11');
    const rotation = await rotate(account);
    await markSessionExpiredDaysAgo(
      rotation.oldSessionId,
      SESSION_RETENTION_DAYS + 1,
    );

    await app.get(DataPurgeService).purge();
    expect(await sessionCountById(rotation.oldSessionId)).toBe(0);

    const response = await request(server())
      .post('/api/v1/auth/refresh')
      .set(CSRF)
      .set('Cookie', rotation.oldRefreshCookie)
      .expect(401);
    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  it('기준 12: 탈퇴 회원 세션도 만료 후 유예가 지나면 지워진다', async () => {
    const account = await createAccount('기준12');
    await withdraw(account);
    await markAllClinicianSessionsPastRetention(account.clinicianId);
    expect(await sessionCountForClinician(account.clinicianId)).toBeGreaterThan(0);

    await app.get(DataPurgeService).purge();

    expect(await sessionCountForClinician(account.clinicianId)).toBe(0);
  });

  it('기준 13: 탈퇴 직후 세션 행은 남고 물리 삭제는 유예 경과 크론 몫이다', async () => {
    const account = await createAccount('기준13');
    await withdraw(account);
    const immediatelyAfterWithdrawal = await sessionCountForClinician(account.clinicianId);
    expect(immediatelyAfterWithdrawal).toBeGreaterThan(0);
    const doomedId = await createDoomedControl('기준13');

    await app.get(DataPurgeService).purge();

    expect(await sessionCountForClinician(account.clinicianId)).toBe(
      immediatelyAfterWithdrawal,
    );
    expect(await sessionCountById(doomedId)).toBe(0);
  });

  it('기준 14: 실제 강퇴로 무소속이 된 회원 세션도 같은 유예 규칙으로 지워진다', async () => {
    const owner = await createAccount('기준14-소유자');
    const memberIdentity = nextIdentity('기준14-강퇴회원');
    const member = await joinByInvitation(app, owner, {
      ...memberIdentity,
      // SocialIdentity.displayName은 string|null, OnboardingInput은 string|undefined다.
      // 단언이 아니라 타입만 좁히는 기계적 수정 (automation/freeze.md 4번).
      displayName: memberIdentity.displayName ?? undefined,
      licenseNumber: `LIC-SPEC39-JOIN-${fixtureSequence}`,
    });

    await request(server())
      .delete(`/api/v1/clinic/members/${member.clinicianId}`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .expect(200);
    const detached = await pool.query<{ clinic_id: string | null }>(
      'SELECT clinic_id FROM clinicians WHERE id = $1',
      [member.clinicianId],
    );
    expect(detached.rows).toEqual([{ clinic_id: null }]);

    await markAllClinicianSessionsPastRetention(member.clinicianId);
    await app.get(DataPurgeService).purge();

    expect(await sessionCountForClinician(member.clinicianId)).toBe(0);
  });

  it('기준 24: 세션 축과 같은 purge() 틱에서도 대화·환자 물리 삭제 결과는 유지된다', async () => {
    const account = await createAccount('기준24');
    const conversationId = await createConversation(account);
    const patientId = await createPatient(account, String(fixtureSequence));

    await request(server())
      .delete(`/api/v1/conversations/${conversationId}`)
      .set(CSRF)
      .set('Cookie', account.cookie)
      .expect(200);
    await request(server())
      .delete(`/api/v1/patients/${patientId}`)
      .set(CSRF)
      .set('Cookie', account.cookie)
      .expect(200);
    const conversationUpdate = await pool.query(
      `UPDATE conversations
          SET deleted_at = now() - interval '400 days'
        WHERE id = $1`,
      [conversationId],
    );
    const patientUpdate = await pool.query(
      `UPDATE patients
          SET deleted_at = now() - interval '400 days'
        WHERE id = $1`,
      [patientId],
    );
    expect(conversationUpdate.rowCount).toBe(1);
    expect(patientUpdate.rowCount).toBe(1);
    const doomedSessionId = await createDoomedControl('기준24');

    await app.get(DataPurgeService).purge();

    expect(await rowCount('conversations', conversationId)).toBe(0);
    expect(await rowCount('patients', patientId)).toBe(0);
    expect(await sessionCountById(doomedSessionId)).toBe(0);
  });

  it('기준 25: 클리닉 파기는 만료 전 구성원 세션도 지우며 새 세션 축과 공존한다', async () => {
    const account = await createAccount('기준25');
    const liveSession = await onlySessionOf(account.clinicianId);
    expect(liveSession.expires_at.getTime()).toBeGreaterThan(Date.now());

    await withdraw(account);
    const scheduled = await pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM clinics WHERE id = $1',
      [account.clinicId],
    );
    expect(scheduled.rows).toHaveLength(1);
    expect(scheduled.rows[0].deleted_at).not.toBeNull();
    const clinicUpdate = await pool.query(
      `UPDATE clinics
          SET deleted_at = now() - interval '400 days'
        WHERE id = $1`,
      [account.clinicId],
    );
    expect(clinicUpdate.rowCount).toBe(1);
    const doomedSessionId = await createDoomedControl('기준25');

    await app.get(DataPurgeService).purge();

    expect(await sessionCountById(liveSession.id)).toBe(0);
    expect(await sessionCountById(doomedSessionId)).toBe(0);
  });
});
