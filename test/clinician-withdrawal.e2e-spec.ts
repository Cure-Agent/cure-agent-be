// docs/specs/36 수용 기준 1~34, 36 동결 테스트 — 구현 중 수정 금지
import { randomUUID } from 'node:crypto';
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
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { DataPurgeService } from '../src/domain/data-purge/service/data-purge.service';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { OAuthProviderId } from '../src/infrastructure/oauth/oauth-provider.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { yotongGuideline } from './fixtures/guideline-samples';
import {
  accessCookieOf,
  joinByInvitation,
  socialCallback,
  socialSignUp,
  type TestSession,
} from './fixtures/social-auth';
import { parseSseEvents, type SseEvent } from './fixtures/sse';

const CSRF = { 'X-CSRF-Protection': '1' };
const PATIENT_GUIDANCE_QUESTION = '이 환자에게 적용할 임상 지침을 알려 주세요.';

interface SyntheticIdentity {
  email: string;
  providerId: string;
  displayName: string;
  licenseNumber: string;
  provider: OAuthProviderId;
}

interface AccountFixture {
  identity: SyntheticIdentity;
  session: TestSession;
}

interface ClinicianState {
  email: string;
  oauth_provider_id: string;
  display_name: string;
  license_number_encrypted: string;
  deleted_at: Date | null;
}

interface AuthSessionState {
  family_id: string;
  revoked_at: Date | null;
}

interface PatientDto {
  id: string;
}

interface CompletedEvent extends SseEvent {
  message?: { id?: string; [key: string]: unknown };
  guidance?: { id?: string; [key: string]: unknown };
}

describe('docs/specs/36: 회원탈퇴 — tombstone + 개설자 이양 + 클리닉 파기', () => {
  jest.setTimeout(300_000);

  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let identitySequence = 0;
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

  const nextIdentity = (
    label: string,
    provider: OAuthProviderId = 'GOOGLE',
  ): SyntheticIdentity => {
    identitySequence += 1;
    const suffix = ulid().toLowerCase();
    return {
      email: `${label}-${identitySequence}-${suffix}@spec36.kr`,
      providerId: `spec36-${label}-${identitySequence}-${suffix}`,
      displayName: `탈퇴동결 ${label} ${identitySequence}`,
      licenseNumber: `LIC-S36-${identitySequence}-${suffix.slice(-6)}`,
      provider,
    };
  };

  const createClinic = async (label: string): Promise<AccountFixture> => {
    const identity = nextIdentity(`${label}-owner`);
    const session = await socialSignUp(app, {
      ...identity,
      clinicName: `탈퇴동결 ${label} 한의원`,
    });
    return { identity, session };
  };

  const joinClinic = async (
    owner: TestSession,
    label: string,
  ): Promise<AccountFixture> => {
    const identity = nextIdentity(`${label}-member`);
    const session = await joinByInvitation(app, owner, identity);
    return { identity, session };
  };

  const clinicianState = async (clinicianId: string): Promise<ClinicianState> => {
    const result = await pool.query<ClinicianState>(
      `SELECT email,
              oauth_provider_id,
              display_name,
              license_number_encrypted,
              deleted_at
         FROM clinicians
        WHERE id = $1`,
      [clinicianId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  };

  const clinicOwnerId = async (clinicId: string): Promise<string | null> => {
    const result = await pool.query<{ owner_clinician_id: string | null }>(
      'SELECT owner_clinician_id FROM clinics WHERE id = $1',
      [clinicId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0].owner_clinician_id;
  };

  const clinicDeletedAt = async (clinicId: string): Promise<Date | null> => {
    const result = await pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM clinics WHERE id = $1',
      [clinicId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0].deleted_at;
  };

  const countRows = async (sql: string, values: unknown[]): Promise<number> => {
    const result = await pool.query<{ count: number }>(sql, values);
    return result.rows[0].count;
  };

  const transferOwner = async (
    actor: TestSession,
    toClinicianId: string,
  ): Promise<SupertestResponse> =>
    request(server())
      .post('/api/v1/clinic/owner/transfer')
      .set(CSRF)
      .set('Cookie', actor.cookie)
      .send({ toClinicianId })
      .expect(200);

  const withdraw = async (session: TestSession): Promise<SupertestResponse> =>
    request(server())
      .delete('/api/v1/auth/me')
      .set(CSRF)
      .set('Cookie', session.cookie)
      .expect(200);

  const issueInvitation = async (
    session: TestSession,
  ): Promise<{ id: string; token: string }> => {
    const response = await request(server())
      .post('/api/v1/clinic/invitations')
      .set(CSRF)
      .set('Cookie', session.cookie)
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      data: { id: expect.any(String), token: expect.any(String) },
    });
    return {
      id: response.body.data.id as string,
      token: response.body.data.token as string,
    };
  };

  const createPatient = async (session: TestSession): Promise<PatientDto> => {
    patientSequence += 1;
    const response = await request(server())
      .post('/api/v1/patients')
      .set(CSRF)
      .set('Cookie', session.cookie)
      .send({
        caseLabel: `회원탈퇴 환자 ${patientSequence}-${ulid()}`,
        birthYear: 1985,
        sex: 'FEMALE',
        heightCm: 165,
        weightKg: 60,
        waistCm: 76,
        diagnoses: ['합성 진단'],
        medications: ['합성 약물'],
        allergies: [],
        clinicalNotes: 'docs/specs/36 회원탈퇴 합성 환자',
      })
      .expect(201);

    expect(response.body.data.id).toEqual(expect.any(String));
    return response.body.data as PatientDto;
  };

  const createConversation = async ({
    session,
    type = 'GUIDELINE_QA',
    patientId,
  }: {
    session: TestSession;
    type?: 'GUIDELINE_QA' | 'PATIENT_GUIDANCE';
    patientId?: string;
  }): Promise<string> => {
    const response = await request(server())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', session.cookie)
      .send({
        type,
        patientId,
        title: `회원탈퇴 대화 ${ulid()}`,
      })
      .expect(201);

    expect(response.body.data).toMatchObject({ id: expect.any(String), type });
    return response.body.data.id as string;
  };

  const streamCompleted = async (
    session: TestSession,
    conversationId: string,
  ): Promise<CompletedEvent> => {
    const response = await request(server())
      .post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', session.cookie)
      .send({ content: PATIENT_GUIDANCE_QUESTION, clientRequestId: randomUUID() })
      .expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    const completed = parseSseEvents(response.text).find(
      (event) => event.eventType === 'answer.completed',
    ) as CompletedEvent | undefined;
    expect(completed).toBeDefined();
    if (!completed) throw new Error('answer.completed 이벤트를 찾지 못했습니다.');
    return completed;
  };

  const markClinicPastRetention = async (clinicId: string): Promise<void> => {
    const result = await pool.query(
      `UPDATE clinics
          SET deleted_at = now() - interval '400 days'
        WHERE id = $1`,
      [clinicId],
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
      // signup은 60초당 20회로 제한되는데(auth.controller.ts의 @Throttle) 이 스위트는
      // 테스트마다 클리닉 개설 + 합류로 2회씩 34회를 부른다. 가입 폭주 방어는 이 스펙의
      // 검증 대상이 아니므로 여기서만 끈다 — 429가 섞이면 구현이 옳아도 통과할 수 없다.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);
    await app.get(GuidelineIngestService).ingest(yotongGuideline);
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

  // ── 구성원 목록 ────────────────────────────────────────

  it('기준 1·2: 같은 클리닉의 개설자·합류자는 모두 보이고 타 클리닉 구성원은 없다', async () => {
    const owner = await createClinic('members-scope');
    const member = await joinClinic(owner.session, 'members-scope');
    const foreign = await createClinic('members-foreign');

    const response = await request(server())
      .get('/api/v1/clinic/members')
      .set('Cookie', owner.session.cookie)
      .expect(200);
    const ids = (response.body.data as Array<{ id: string }>).map((item) => item.id);

    expect(ids).toContain(owner.session.clinicianId);
    expect(ids).toContain(member.session.clinicianId);
    expect(ids).not.toContain(foreign.session.clinicianId);
  });

  it('기준 3·4: tombstone은 목록에서 빠지고 비개설자도 목록을 200으로 조회한다', async () => {
    const owner = await createClinic('members-tombstone');
    const tombstone = await joinClinic(owner.session, 'members-tombstone-target');
    const viewer = await joinClinic(owner.session, 'members-tombstone-viewer');

    await withdraw(tombstone.session);
    expect((await clinicianState(tombstone.session.clinicianId)).deleted_at).not.toBeNull();

    const response = await request(server())
      .get('/api/v1/clinic/members')
      .set('Cookie', viewer.session.cookie)
      .expect(200);
    const ids = (response.body.data as Array<{ id: string }>).map((item) => item.id);

    expect(ids).toContain(owner.session.clinicianId);
    expect(ids).toContain(viewer.session.clinicianId);
    expect(ids).not.toContain(tombstone.session.clinicianId);
  });

  // ── 개설자 이양 ────────────────────────────────────────

  it('기준 5·6·7: 이양은 owner를 바꾸고 초대 권한도 이전 개설자에서 새 개설자로 옮긴다', async () => {
    const owner = await createClinic('transfer-authority');
    const member = await joinClinic(owner.session, 'transfer-authority');

    const transferred = await transferOwner(owner.session, member.session.clinicianId);
    expect(transferred.body).toMatchObject({ success: true, data: null });
    expect(await clinicOwnerId(owner.session.clinicId)).toBe(member.session.clinicianId);

    const denied = await request(server())
      .post('/api/v1/clinic/invitations')
      .set(CSRF)
      .set('Cookie', owner.session.cookie)
      .expect(403);
    expect(denied.body.code).toBe('FORBIDDEN');

    const issued = await request(server())
      .post('/api/v1/clinic/invitations')
      .set(CSRF)
      .set('Cookie', member.session.cookie)
      .expect(201);
    expect(issued.body.data.token).toEqual(expect.any(String));
  });

  it('기준 8: 정상 이양 경로가 200인 상태에서도 개설자가 아닌 구성원의 이양 시도는 403이다', async () => {
    const owner = await createClinic('transfer-forbidden');
    const nextOwner = await joinClinic(owner.session, 'transfer-forbidden-next');
    const nonOwner = await joinClinic(owner.session, 'transfer-forbidden-actor');

    await transferOwner(owner.session, nextOwner.session.clinicianId);
    expect(await clinicOwnerId(owner.session.clinicId)).toBe(nextOwner.session.clinicianId);

    const denied = await request(server())
      .post('/api/v1/clinic/owner/transfer')
      .set(CSRF)
      .set('Cookie', nonOwner.session.cookie)
      .send({ toClinicianId: owner.session.clinicianId })
      .expect(403);
    expect(denied.body.code).toBe('FORBIDDEN');
  });

  it('기준 9: 같은 클리닉 대상 이양은 owner를 바꾸지만 타 클리닉 대상은 404이고 owner가 불변이다', async () => {
    const owner = await createClinic('transfer-foreign');
    const sameClinicMember = await joinClinic(owner.session, 'transfer-foreign-local');
    const foreign = await createClinic('transfer-foreign-target');

    // 필수 양성 대조군: 같은 라우트·같은 클리닉 대상은 200이고 DB owner를 실제로 바꾼다.
    await transferOwner(owner.session, sameClinicMember.session.clinicianId);
    expect(await clinicOwnerId(owner.session.clinicId)).toBe(
      sameClinicMember.session.clinicianId,
    );

    const hidden = await request(server())
      .post('/api/v1/clinic/owner/transfer')
      .set(CSRF)
      .set('Cookie', sameClinicMember.session.cookie)
      .send({ toClinicianId: foreign.session.clinicianId })
      .expect(404);
    expect(hidden.body.code).toBe('NOT_FOUND');
    expect(await clinicOwnerId(owner.session.clinicId)).toBe(
      sameClinicMember.session.clinicianId,
    );
  });

  it('기준 10: 살아 있는 같은 클리닉 대상은 200이지만 tombstone 대상 이양은 404다', async () => {
    const owner = await createClinic('transfer-tombstone');
    const tombstone = await joinClinic(owner.session, 'transfer-tombstone-target');
    const liveMember = await joinClinic(owner.session, 'transfer-tombstone-live');

    await withdraw(tombstone.session);
    expect((await clinicianState(tombstone.session.clinicianId)).deleted_at).not.toBeNull();

    // 필수 양성 대조군: 살아 있는 같은 클리닉 구성원에게는 이양이 실제 성공한다.
    await transferOwner(owner.session, liveMember.session.clinicianId);
    expect(await clinicOwnerId(owner.session.clinicId)).toBe(liveMember.session.clinicianId);

    const hidden = await request(server())
      .post('/api/v1/clinic/owner/transfer')
      .set(CSRF)
      .set('Cookie', liveMember.session.cookie)
      .send({ toClinicianId: tombstone.session.clinicianId })
      .expect(404);
    expect(hidden.body.code).toBe('NOT_FOUND');
    expect(await clinicOwnerId(owner.session.clinicId)).toBe(liveMember.session.clinicianId);
  });

  it('기준 11: 자기 자신에게 이양하면 200이고 owner가 그대로다', async () => {
    const owner = await createClinic('transfer-self');
    expect(await clinicOwnerId(owner.session.clinicId)).toBe(owner.session.clinicianId);

    const response = await transferOwner(owner.session, owner.session.clinicianId);

    expect(response.body).toMatchObject({ success: true, data: null });
    expect(await clinicOwnerId(owner.session.clinicId)).toBe(owner.session.clinicianId);
  });

  // ── 탈퇴 — 일반 구성원 ─────────────────────────────────

  it('기준 12~17: 일반 구성원 탈퇴는 200 + null이고 개인정보 네 필드를 즉시 익명화한다', async () => {
    const owner = await createClinic('withdraw-tombstone');
    const member = await joinClinic(owner.session, 'withdraw-tombstone');
    const before = await clinicianState(member.session.clinicianId);
    expect(before.deleted_at).toBeNull();

    const response = await withdraw(member.session);
    expect(response.body).toMatchObject({ success: true, data: null });

    const after = await clinicianState(member.session.clinicianId);
    expect(after.deleted_at).not.toBeNull();
    expect(after.email).not.toBe(before.email);
    expect(after.oauth_provider_id).not.toBe(before.oauth_provider_id);
    expect(after.display_name).not.toBe(before.display_name);
    expect(after.license_number_encrypted).not.toBe(before.license_number_encrypted);
  });

  it('기준 18·19: 여러 로그인 family를 전부 폐기하고 기존 access 토큰도 즉시 401로 막는다', async () => {
    const owner = await createClinic('withdraw-sessions');
    const member = await joinClinic(owner.session, 'withdraw-sessions');
    const loginCookies: string[] = [];

    for (let index = 0; index < 2; index += 1) {
      const callback = await socialCallback(app, member.identity);
      expect(callback.ticket).toBeNull();
      loginCookies.push(accessCookieOf(callback.response));
    }

    const before = await pool.query<AuthSessionState>(
      `SELECT family_id, revoked_at
         FROM auth_sessions
        WHERE clinician_id = $1
        ORDER BY family_id`,
      [member.session.clinicianId],
    );
    expect(before.rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(before.rows.map((row) => row.family_id)).size).toBeGreaterThanOrEqual(3);
    for (const row of before.rows) expect(row.revoked_at).toBeNull();

    // 양성 대조: 탈퇴 직전에는 별도 family의 access 토큰이 유효하다.
    await request(server())
      .get('/api/v1/auth/me')
      .set('Cookie', loginCookies[1])
      .expect(200);

    await withdraw(member.session);

    const after = await pool.query<AuthSessionState>(
      `SELECT family_id, revoked_at
         FROM auth_sessions
        WHERE clinician_id = $1
        ORDER BY family_id`,
      [member.session.clinicianId],
    );
    expect(after.rows).toHaveLength(before.rows.length);
    for (const row of after.rows) expect(row.revoked_at).not.toBeNull();

    const denied = await request(server())
      .get('/api/v1/auth/me')
      .set('Cookie', loginCookies[1])
      .expect(401);
    expect(denied.body.code).toBe('UNAUTHORIZED');
  });

  it('기준 20·21: 탈퇴자가 만든 공유 대화와 feedback·review 감사 행은 남은 동료에게 보존된다', async () => {
    const owner = await createClinic('withdraw-assets');
    const member = await joinClinic(owner.session, 'withdraw-assets');
    const patient = await createPatient(member.session);
    const conversationId = await createConversation({
      session: member.session,
      type: 'PATIENT_GUIDANCE',
      patientId: patient.id,
    });
    const completed = await streamCompleted(member.session, conversationId);
    const messageId = completed.message?.id;
    const guidanceId = completed.guidance?.id;
    expect(messageId).toEqual(expect.any(String));
    expect(guidanceId).toEqual(expect.any(String));
    if (!messageId || !guidanceId) {
      throw new Error('감사 기록 fixture의 message 또는 guidance id가 없습니다.');
    }

    await request(server())
      .post(`/api/v1/messages/${messageId}/feedback`)
      .set(CSRF)
      .set('Cookie', member.session.cookie)
      .send({ rating: 'HELPFUL', comment: '탈퇴 전 감사 기록' })
      .expect(200);
    await request(server())
      .post(`/api/v1/clinical-guidance/${guidanceId}/reviews`)
      .set(CSRF)
      .set('Cookie', member.session.cookie)
      .send({ decision: 'ACCEPTED', note: '탈퇴 전 검토 기록' })
      .expect(200);

    const feedbackCount = () =>
      countRows(
        `SELECT count(*)::int AS count
           FROM answer_feedbacks
          WHERE message_id = $1 AND clinician_id = $2`,
        [messageId, member.session.clinicianId],
      );
    const reviewCount = () =>
      countRows(
        `SELECT count(*)::int AS count
           FROM guidance_reviews
          WHERE guidance_id = $1 AND clinician_id = $2`,
        [guidanceId, member.session.clinicianId],
      );
    expect(await feedbackCount()).toBe(1);
    expect(await reviewCount()).toBe(1);

    await withdraw(member.session);

    const shared = await request(server())
      .get(`/api/v1/conversations/${conversationId}`)
      .set('Cookie', owner.session.cookie)
      .expect(200);
    expect(shared.body.data.id).toBe(conversationId);
    expect(await feedbackCount()).toBe(1);
    expect(await reviewCount()).toBe(1);
  });

  it('기준 22·23: 같은 소셜 identity는 신규 가입 티켓을 받고 새 clinicianId로 재가입한다', async () => {
    const owner = await createClinic('withdraw-rejoin');
    const member = await joinClinic(owner.session, 'withdraw-rejoin');
    const oldClinicianId = member.session.clinicianId;

    await withdraw(member.session);

    const callback = await socialCallback(app, member.identity);
    expect(callback.ticket).toEqual(expect.any(String));
    if (!callback.ticket) throw new Error('재가입용 신규 가입 티켓이 없습니다.');

    const signup = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        ticket: callback.ticket,
        displayName: `${member.identity.displayName} 재가입`,
        clinicName: `재가입 한의원 ${ulid()}`,
        licenseNumber: `${member.identity.licenseNumber}-REJOIN`,
        termsAccepted: true,
      })
      .expect(201);
    const newClinicianId = signup.body.data.clinician.id as string;

    expect(newClinicianId).toEqual(expect.any(String));
    expect(newClinicianId).not.toBe(oldClinicianId);
  });

  // ── 탈퇴 — 개설자 ──────────────────────────────────────

  it('기준 24~27: 구성원이 남은 개설자 탈퇴는 무변경 409이고 이양 후 같은 사람은 200이다', async () => {
    const owner = await createClinic('withdraw-owner-blocked');
    const member = await joinClinic(owner.session, 'withdraw-owner-blocked');
    const before = await clinicianState(owner.session.clinicianId);
    expect(before.deleted_at).toBeNull();

    const blocked = await request(server())
      .delete('/api/v1/auth/me')
      .set(CSRF)
      .set('Cookie', owner.session.cookie)
      .expect(409);
    expect(blocked.body.code).toBe('CLINIC_OWNER_MUST_TRANSFER');

    const afterBlocked = await clinicianState(owner.session.clinicianId);
    expect(afterBlocked.deleted_at).toBeNull();
    expect(afterBlocked.email).toBe(before.email);

    await transferOwner(owner.session, member.session.clinicianId);
    expect(await clinicOwnerId(owner.session.clinicId)).toBe(member.session.clinicianId);

    // 409의 필수 양성 대조군: 이양 뒤 같은 DELETE 경로가 같은 사람에게 200으로 열린다.
    const completed = await withdraw(owner.session);
    expect(completed.body).toMatchObject({ success: true, data: null });
    expect((await clinicianState(owner.session.clinicianId)).deleted_at).not.toBeNull();
  });

  // ── 탈퇴 — 마지막 구성원 ───────────────────────────────

  it('기준 28·29: 마지막 구성원인 개설자는 409 없이 200으로 탈퇴하고 clinic을 삭제 예약한다', async () => {
    const owner = await createClinic('withdraw-last');
    expect(await clinicDeletedAt(owner.session.clinicId)).toBeNull();

    const response = await withdraw(owner.session);

    expect(response.body).toMatchObject({ success: true, data: null });
    expect(await clinicDeletedAt(owner.session.clinicId)).not.toBeNull();
  });

  it('기준 30: 구성원이 둘일 때 비개설자 한 명의 탈퇴는 clinics.deleted_at을 채우지 않는다', async () => {
    const owner = await createClinic('withdraw-not-last');
    const member = await joinClinic(owner.session, 'withdraw-not-last');
    expect(await clinicDeletedAt(owner.session.clinicId)).toBeNull();

    await withdraw(member.session);

    expect(await clinicDeletedAt(owner.session.clinicId)).toBeNull();
  });

  // ── 파기 크론 ──────────────────────────────────────────

  it('기준 31~34: 유예 경과 clinic 파기는 clinic·clinician·patient·conversation·invitation을 모두 지운다', async () => {
    const owner = await createClinic('purge-clinic-tree');
    await createPatient(owner.session);
    await createConversation({ session: owner.session });
    await issueInvitation(owner.session);

    expect(
      await countRows('SELECT count(*)::int AS count FROM clinics WHERE id = $1', [
        owner.session.clinicId,
      ]),
    ).toBe(1);
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM clinicians WHERE clinic_id = $1',
        [owner.session.clinicId],
      ),
    ).toBeGreaterThan(0);
    expect(
      await countRows('SELECT count(*)::int AS count FROM patients WHERE clinic_id = $1', [
        owner.session.clinicId,
      ]),
    ).toBeGreaterThan(0);
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM conversations WHERE clinic_id = $1',
        [owner.session.clinicId],
      ),
    ).toBeGreaterThan(0);
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM clinic_invitations WHERE clinic_id = $1',
        [owner.session.clinicId],
      ),
    ).toBeGreaterThan(0);

    await markClinicPastRetention(owner.session.clinicId);
    await app.get(DataPurgeService).purge();

    expect(
      await countRows('SELECT count(*)::int AS count FROM clinics WHERE id = $1', [
        owner.session.clinicId,
      ]),
    ).toBe(0);
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM clinicians WHERE clinic_id = $1',
        [owner.session.clinicId],
      ),
    ).toBe(0);
    expect(
      await countRows('SELECT count(*)::int AS count FROM patients WHERE clinic_id = $1', [
        owner.session.clinicId,
      ]),
    ).toBe(0);
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM conversations WHERE clinic_id = $1',
        [owner.session.clinicId],
      ),
    ).toBe(0);
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM clinic_invitations WHERE clinic_id = $1',
        [owner.session.clinicId],
      ),
    ).toBe(0);
  });

  it('기준 36: 유예 경과 양성 대조 clinic은 지우지만 deleted_at이 null인 clinic은 그대로 둔다', async () => {
    const purgeable = await createClinic('purge-positive-control');
    const live = await createClinic('purge-live');
    await markClinicPastRetention(purgeable.session.clinicId);
    expect(await clinicDeletedAt(live.session.clinicId)).toBeNull();

    await app.get(DataPurgeService).purge();

    // 이 양성 대조가 클리닉 파기 no-op의 우연한 통과를 막는다.
    expect(
      await countRows('SELECT count(*)::int AS count FROM clinics WHERE id = $1', [
        purgeable.session.clinicId,
      ]),
    ).toBe(0);
    expect(
      await countRows('SELECT count(*)::int AS count FROM clinics WHERE id = $1', [
        live.session.clinicId,
      ]),
    ).toBe(1);
    expect(await clinicDeletedAt(live.session.clinicId)).toBeNull();
  });
});
