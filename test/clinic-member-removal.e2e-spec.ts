// docs/specs/38 수용 기준 1~39 동결 테스트 — 구현 중 수정 금지
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
import { ClinicianRepository } from '../src/domain/clinician/repository/clinician.repository';
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
  setCookies,
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
  clinic_id: string | null;
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

interface RemovalState {
  clinic_id: string;
  removed_clinician_id: string;
  removed_by_clinician_id: string;
}

interface InvitationState {
  id: string;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

interface PatientDto {
  id: string;
}

interface CompletedEvent extends SseEvent {
  message?: { id?: string; [key: string]: unknown };
  guidance?: { id?: string; [key: string]: unknown };
}

describe('docs/specs/38: 구성원 강퇴 — 무소속 전환 + 재온보딩', () => {
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
      email:
        label +
        '-' +
        String(identitySequence) +
        '-' +
        suffix +
        '@spec38.kr',
      providerId:
        'spec38-' + label + '-' + String(identitySequence) + '-' + suffix,
      displayName: '강퇴동결 ' + label + ' ' + String(identitySequence),
      licenseNumber:
        'LIC-S38-' + String(identitySequence) + '-' + suffix.slice(-6),
      provider,
    };
  };

  const createClinic = async (label: string): Promise<AccountFixture> => {
    const identity = nextIdentity(label + '-owner');
    const session = await socialSignUp(app, {
      ...identity,
      clinicName: '강퇴동결 ' + label + ' 한의원',
    });
    return { identity, session };
  };

  const joinClinic = async (
    owner: TestSession,
    label: string,
  ): Promise<AccountFixture> => {
    const identity = nextIdentity(label + '-member');
    const session = await joinByInvitation(app, owner, identity);
    return { identity, session };
  };

  const clinicianState = async (clinicianId: string): Promise<ClinicianState> => {
    const result = await pool.query<ClinicianState>(
      'SELECT clinic_id, email, oauth_provider_id, display_name, license_number_encrypted, deleted_at FROM clinicians WHERE id = $1',
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

  const countRows = async (sql: string, values: unknown[]): Promise<number> => {
    const result = await pool.query<{ count: number }>(sql, values);
    return result.rows[0].count;
  };

  const memberIds = async (session: TestSession): Promise<string[]> => {
    const response = await request(server())
      .get('/api/v1/clinic/members')
      .set('Cookie', session.cookie)
      .expect(200);
    return (response.body.data as Array<{ id: string }>).map((item) => item.id);
  };

  const removeMember = async (
    actor: TestSession,
    clinicianId: string,
  ): Promise<SupertestResponse> =>
    request(server())
      .delete('/api/v1/clinic/members/' + clinicianId)
      .set(CSRF)
      .set('Cookie', actor.cookie);

  const withdraw = async (session: TestSession): Promise<SupertestResponse> =>
    request(server())
      .delete('/api/v1/auth/me')
      .set(CSRF)
      .set('Cookie', session.cookie)
      .expect(200);

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

  const invitationState = async (invitationId: string): Promise<InvitationState> => {
    const result = await pool.query<InvitationState>(
      'SELECT id, accepted_at, revoked_at FROM clinic_invitations WHERE id = $1',
      [invitationId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  };

  const acceptedInvitationInClinic = async (
    clinicId: string,
  ): Promise<InvitationState> => {
    const result = await pool.query<InvitationState>(
      'SELECT id, accepted_at, revoked_at FROM clinic_invitations WHERE clinic_id = $1 AND accepted_at IS NOT NULL ORDER BY created_at DESC LIMIT 1',
      [clinicId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  };

  const refreshCookieOf = (response: SupertestResponse): string => {
    const raw = setCookies(response).refresh_token;
    if (!raw) throw new Error('응답에 refresh_token 쿠키가 없습니다.');
    return raw.split(';')[0];
  };

  const createPatient = async (session: TestSession): Promise<PatientDto> => {
    patientSequence += 1;
    const response = await request(server())
      .post('/api/v1/patients')
      .set(CSRF)
      .set('Cookie', session.cookie)
      .send({
        caseLabel:
          '구성원 강퇴 환자 ' + String(patientSequence) + '-' + ulid(),
        birthYear: 1985,
        sex: 'FEMALE',
        heightCm: 165,
        weightKg: 60,
        waistCm: 76,
        diagnoses: ['합성 진단'],
        medications: ['합성 약물'],
        allergies: [],
        clinicalNotes: 'docs/specs/38 구성원 강퇴 합성 환자',
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
        title: '구성원 강퇴 대화 ' + ulid(),
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
      .post(
        '/api/v1/conversations/' + conversationId + '/messages/stream',
      )
      .set(CSRF)
      .set('Cookie', session.cookie)
      .send({
        content: PATIENT_GUIDANCE_QUESTION,
        clientRequestId: randomUUID(),
      })
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
      "UPDATE clinics SET deleted_at = now() - interval '400 days' WHERE id = $1",
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
      // signup은 60초당 20회로 제한되지만 이 스위트는 가입과 재온보딩을 수십 회 수행한다.
      // 가입 폭주 방어는 docs/specs/38의 검증 대상이 아니므로 이 스위트에서만 무력화한다.
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

  // ── 강퇴 — 소속만 끊는다 ───────────────────────────────

  it('기준 1~8: 강퇴는 200 + null이고 소속만 끊어 계정 원본과 목록 경계를 보존한다', async () => {
    const owner = await createClinic('detach-only');
    const member = await joinClinic(owner.session, 'detach-only');
    const before = await clinicianState(member.session.clinicianId);
    const membersBefore = await memberIds(owner.session);

    expect(membersBefore).toContain(member.session.clinicianId);
    expect(before.clinic_id).toBe(owner.session.clinicId);
    expect(before.deleted_at).toBeNull();

    const response = await removeMember(
      owner.session,
      member.session.clinicianId,
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toBeNull();

    const after = await clinicianState(member.session.clinicianId);
    expect(after.clinic_id).toBeNull();

    const membersAfter = await memberIds(owner.session);
    expect(membersAfter).not.toContain(member.session.clinicianId);

    expect(after.deleted_at).toBeNull();
    expect(after.email).toBe(before.email);
    expect(after.license_number_encrypted).toBe(
      before.license_number_encrypted,
    );
    expect(after.display_name).toBe(before.display_name);
    expect(after.oauth_provider_id).toBe(before.oauth_provider_id);
  });

  // ── 즉시 차단 ──────────────────────────────────────────

  it('기준 9~12: 강퇴는 모든 family와 기존 쿠키를 즉시 막고 findById에서도 무소속을 숨긴다', async () => {
    const owner = await createClinic('sessions');
    const member = await joinClinic(owner.session, 'sessions');
    const accessCookies: string[] = [];
    const refreshCookies: string[] = [];

    for (let index = 0; index < 2; index += 1) {
      const callback = await socialCallback(app, member.identity);
      expect(callback.ticket).toBeNull();
      accessCookies.push(accessCookieOf(callback.response));
      refreshCookies.push(refreshCookieOf(callback.response));
    }

    const sessionsBefore = await pool.query<AuthSessionState>(
      'SELECT family_id, revoked_at FROM auth_sessions WHERE clinician_id = $1 ORDER BY family_id',
      [member.session.clinicianId],
    );
    expect(sessionsBefore.rows.length).toBeGreaterThanOrEqual(3);
    expect(
      new Set(sessionsBefore.rows.map((row) => row.family_id)).size,
    ).toBeGreaterThanOrEqual(3);
    for (const row of sessionsBefore.rows) {
      expect(row.revoked_at).toBeNull();
    }

    // 양성 대조: 강퇴 직전에는 같은 access 쿠키로 보호 API를 호출할 수 있다.
    const allowedBefore = await request(server())
      .get('/api/v1/auth/me')
      .set('Cookie', accessCookies[1]);
    expect(allowedBefore.status).toBe(200);

    const clinicianRepository = app.get(ClinicianRepository);
    const foundBefore = await clinicianRepository.findById(
      member.session.clinicianId,
    );
    expect(foundBefore).not.toBeNull();

    const removed = await removeMember(
      owner.session,
      member.session.clinicianId,
    );
    expect(removed.status).toBe(200);

    const deniedAccess = await request(server())
      .get('/api/v1/auth/me')
      .set('Cookie', accessCookies[1]);
    expect(deniedAccess.status).toBe(401);

    const sessionsAfter = await pool.query<AuthSessionState>(
      'SELECT family_id, revoked_at FROM auth_sessions WHERE clinician_id = $1 ORDER BY family_id',
      [member.session.clinicianId],
    );
    expect(sessionsAfter.rows).toHaveLength(sessionsBefore.rows.length);
    for (const row of sessionsAfter.rows) {
      expect(row.revoked_at).not.toBeNull();
    }

    const deniedRefresh = await request(server())
      .post('/api/v1/auth/refresh')
      .set(CSRF)
      .set('Cookie', refreshCookies[1]);
    expect(deniedRefresh.status).toBe(401);

    const foundAfter = await clinicianRepository.findById(
      member.session.clinicianId,
    );
    expect(foundAfter).toBeNull();
  });

  // ── 권한·대상 ──────────────────────────────────────────

  it('기준 13: 비개설자의 강퇴는 403 FORBIDDEN이지만 개설자의 같은 라우트는 실제로 소속을 끊는다', async () => {
    const owner = await createClinic('forbidden');
    const target = await joinClinic(owner.session, 'forbidden-target');
    const nonOwner = await joinClinic(owner.session, 'forbidden-actor');

    const denied = await removeMember(
      nonOwner.session,
      target.session.clinicianId,
    );
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');

    // 필수 양성 대조군: 같은 라우트에 개설자가 보낸 요청은 200 + null이고 DB 소속을 실제로 끊는다.
    const allowed = await removeMember(
      owner.session,
      target.session.clinicianId,
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toBeNull();
    expect(
      (await clinicianState(target.session.clinicianId)).clinic_id,
    ).toBeNull();
  });

  it('기준 14: 타 클리닉 대상은 404 NOT_FOUND와 무변경이고 같은 클리닉 대상은 200 + NULL이다', async () => {
    const owner = await createClinic('foreign');
    const local = await joinClinic(owner.session, 'foreign-local');
    const foreign = await createClinic('foreign-target');
    const foreignBefore = await clinicianState(foreign.session.clinicianId);

    const hidden = await removeMember(
      owner.session,
      foreign.session.clinicianId,
    );
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe('NOT_FOUND');
    expect(
      (await clinicianState(foreign.session.clinicianId)).clinic_id,
    ).toBe(foreignBefore.clinic_id);

    // 필수 양성 대조군: 같은 클리닉의 살아 있는 대상은 200이고 clinic_id가 실제 NULL이 된다.
    const allowed = await removeMember(
      owner.session,
      local.session.clinicianId,
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toBeNull();
    expect(
      (await clinicianState(local.session.clinicianId)).clinic_id,
    ).toBeNull();
  });

  it('기준 15: tombstone 대상은 404이지만 살아 있는 같은 클리닉 대상은 200이다', async () => {
    const owner = await createClinic('tombstone');
    const tombstone = await joinClinic(owner.session, 'tombstone-target');
    const live = await joinClinic(owner.session, 'tombstone-live');

    await withdraw(tombstone.session);
    expect(
      (await clinicianState(tombstone.session.clinicianId)).deleted_at,
    ).not.toBeNull();

    const hidden = await removeMember(
      owner.session,
      tombstone.session.clinicianId,
    );
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe('NOT_FOUND');

    // 필수 양성 대조군: 살아 있는 같은 클리닉 구성원은 같은 라우트에서 200으로 강퇴된다.
    const allowed = await removeMember(
      owner.session,
      live.session.clinicianId,
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toBeNull();
    expect(
      (await clinicianState(live.session.clinicianId)).clinic_id,
    ).toBeNull();
  });

  it('기준 16·17: 개설자의 자기 강퇴는 409 전용 코드이고 clinic_id를 먼저 바꾸지 않는다', async () => {
    const owner = await createClinic('self');
    await joinClinic(owner.session, 'self-member');
    const before = await clinicianState(owner.session.clinicianId);
    expect(before.clinic_id).toBe(owner.session.clinicId);

    const blocked = await removeMember(
      owner.session,
      owner.session.clinicianId,
    );

    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('CLINIC_OWNER_CANNOT_REMOVE_SELF');
    expect(
      (await clinicianState(owner.session.clinicianId)).clinic_id,
    ).toBe(before.clinic_id);
  });

  // ── 기록은 클리닉에 남는다 ─────────────────────────────

  it('기준 18~20: 강퇴자의 공유 대화와 작성자·feedback·review 감사 기록은 남는다', async () => {
    const owner = await createClinic('assets');
    const member = await joinClinic(owner.session, 'assets');
    const patient = await createPatient(member.session);
    const conversationId = await createConversation({
      session: member.session,
      type: 'PATIENT_GUIDANCE',
      patientId: patient.id,
    });
    const completed = await streamCompleted(
      member.session,
      conversationId,
    );
    const messageId = completed.message?.id;
    const guidanceId = completed.guidance?.id;
    expect(messageId).toEqual(expect.any(String));
    expect(guidanceId).toEqual(expect.any(String));
    if (!messageId || !guidanceId) {
      throw new Error('감사 기록 fixture의 message 또는 guidance id가 없습니다.');
    }

    await request(server())
      .post('/api/v1/messages/' + messageId + '/feedback')
      .set(CSRF)
      .set('Cookie', member.session.cookie)
      .send({ rating: 'HELPFUL', comment: '강퇴 전 합성 감사 기록' })
      .expect(200);
    await request(server())
      .post('/api/v1/clinical-guidance/' + guidanceId + '/reviews')
      .set(CSRF)
      .set('Cookie', member.session.cookie)
      .send({ decision: 'ACCEPTED', note: '강퇴 전 합성 검토 기록' })
      .expect(200);

    const feedbackCount = () =>
      countRows(
        'SELECT count(*)::int AS count FROM answer_feedbacks WHERE message_id = $1 AND clinician_id = $2',
        [messageId, member.session.clinicianId],
      );
    const reviewCount = () =>
      countRows(
        'SELECT count(*)::int AS count FROM guidance_reviews WHERE guidance_id = $1 AND clinician_id = $2',
        [guidanceId, member.session.clinicianId],
      );
    expect(await feedbackCount()).toBe(1);
    expect(await reviewCount()).toBe(1);

    const removed = await removeMember(
      owner.session,
      member.session.clinicianId,
    );
    expect(removed.status).toBe(200);

    const shared = await request(server())
      .get('/api/v1/conversations/' + conversationId)
      .set('Cookie', owner.session.cookie);
    expect(shared.status).toBe(200);
    expect(shared.body.data.id).toBe(conversationId);

    const author = await pool.query<{ clinician_id: string }>(
      'SELECT clinician_id FROM conversations WHERE id = $1',
      [conversationId],
    );
    expect(author.rows).toHaveLength(1);
    expect(author.rows[0].clinician_id).toBe(member.session.clinicianId);

    expect(await feedbackCount()).toBe(1);
    expect(await reviewCount()).toBe(1);
  });

  // ── 강퇴 이력 ──────────────────────────────────────────

  it('기준 21~23: 강퇴 이력은 정확히 한 행이며 행위자와 강퇴 시점 clinic을 고정한다', async () => {
    const owner = await createClinic('history');
    const member = await joinClinic(owner.session, 'history');

    const removed = await removeMember(
      owner.session,
      member.session.clinicianId,
    );
    expect(removed.status).toBe(200);
    expect(
      (await clinicianState(member.session.clinicianId)).clinic_id,
    ).toBeNull();

    const history = await pool.query<RemovalState>(
      'SELECT clinic_id, removed_clinician_id, removed_by_clinician_id FROM clinic_member_removals WHERE removed_clinician_id = $1 ORDER BY created_at',
      [member.session.clinicianId],
    );
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0].removed_by_clinician_id).toBe(
      owner.session.clinicianId,
    );
    expect(history.rows[0].clinic_id).toBe(owner.session.clinicId);
  });

  it('기준 24: 같은 사람이 초대로 재합류한 뒤 다시 강퇴되면 이력이 두 행이다', async () => {
    const owner = await createClinic('history-repeat');
    const member = await joinClinic(owner.session, 'history-repeat');

    const firstRemoval = await removeMember(
      owner.session,
      member.session.clinicianId,
    );
    expect(firstRemoval.status).toBe(200);
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM clinic_member_removals WHERE removed_clinician_id = $1',
        [member.session.clinicianId],
      ),
    ).toBe(1);

    const invitation = await issueInvitation(owner.session);
    const callback = await socialCallback(app, member.identity);
    expect(callback.ticket).toEqual(expect.any(String));
    if (!callback.ticket) throw new Error('재합류용 온보딩 티켓이 없습니다.');

    const rejoined = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        ticket: callback.ticket,
        displayName: member.identity.displayName + ' 재합류',
        invitationToken: invitation.token,
        licenseNumber: member.identity.licenseNumber + '-REJOIN',
        termsAccepted: true,
      });
    expect(rejoined.status).toBe(201);
    expect(rejoined.body.data.clinician.id).toBe(
      member.session.clinicianId,
    );

    const secondRemoval = await removeMember(
      owner.session,
      member.session.clinicianId,
    );
    expect(secondRemoval.status).toBe(200);
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM clinic_member_removals WHERE removed_clinician_id = $1',
        [member.session.clinicianId],
      ),
    ).toBe(2);
  });

  // ── 발급했던 초대의 처분 ───────────────────────────────

  it('기준 25~28: 강퇴자의 pending 초대만 취소하고 프리뷰를 숨기며 타인 초대와 accepted 시각은 보존한다', async () => {
    const firstOwner = await createClinic('invitation-disposal');
    const nextOwner = await joinClinic(
      firstOwner.session,
      'invitation-disposal-next-owner',
    );
    const acceptedBefore = await acceptedInvitationInClinic(
      firstOwner.session.clinicId,
    );
    expect(acceptedBefore.accepted_at).not.toBeNull();
    expect(acceptedBefore.revoked_at).toBeNull();

    const targetPending = await issueInvitation(firstOwner.session);
    expect(
      (await invitationState(targetPending.id)).revoked_at,
    ).toBeNull();

    const transferred = await transferOwner(
      firstOwner.session,
      nextOwner.session.clinicianId,
    );
    expect(transferred.status).toBe(200);
    expect(await clinicOwnerId(firstOwner.session.clinicId)).toBe(
      nextOwner.session.clinicianId,
    );

    const otherPending = await issueInvitation(nextOwner.session);
    expect(
      (await invitationState(otherPending.id)).revoked_at,
    ).toBeNull();

    const removed = await removeMember(
      nextOwner.session,
      firstOwner.session.clinicianId,
    );
    expect(removed.status).toBe(200);

    const targetAfter = await invitationState(targetPending.id);
    expect(targetAfter.revoked_at).not.toBeNull();

    const preview = await request(server()).get(
      '/api/v1/invitations/' + targetPending.token,
    );
    expect(preview.status).toBe(404);
    expect(preview.body.code).toBe('INVITATION_INVALID');

    const otherAfter = await invitationState(otherPending.id);
    expect(otherAfter.revoked_at).toBeNull();

    const acceptedAfter = await invitationState(acceptedBefore.id);
    expect(acceptedAfter.accepted_at).toEqual(acceptedBefore.accepted_at);
  });

  // ── 재온보딩 — 무소속에서 나가는 문 ───────────────────

  it('기준 29~35: 이메일 없는 재로그인도 비로그인 티켓을 받고 같은 행으로 새 clinic을 개설한다', async () => {
    const owner = await createClinic('re-onboard-clinic');
    const member = await joinClinic(owner.session, 're-onboard-clinic');
    const before = await clinicianState(member.session.clinicianId);

    const removed = await removeMember(
      owner.session,
      member.session.clinicianId,
    );
    expect(removed.status).toBe(200);
    const clinicianCountBefore = await countRows(
      'SELECT count(*)::int AS count FROM clinicians',
      [],
    );

    const callback = await socialCallback(app, {
      provider: member.identity.provider,
      providerId: member.identity.providerId,
      email: null,
      displayName: member.identity.displayName,
    });
    expect(callback.ticket).not.toBeNull();
    expect(callback.ticket).toEqual(expect.any(String));
    expect(setCookies(callback.response).access_token).toBeUndefined();
    if (!callback.ticket) throw new Error('재온보딩 티켓이 없습니다.');

    const signup = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        ticket: callback.ticket,
        displayName: member.identity.displayName + ' 재온보딩',
        clinicName: '재온보딩 한의원 ' + ulid(),
        licenseNumber: member.identity.licenseNumber + '-NEW',
        termsAccepted: true,
      });

    expect(signup.status).toBe(201);
    expect(signup.body.data.clinician.id).toBe(
      member.session.clinicianId,
    );
    expect(
      await countRows('SELECT count(*)::int AS count FROM clinicians', []),
    ).toBe(clinicianCountBefore);

    const after = await clinicianState(member.session.clinicianId);
    expect(after.email).toBe(before.email);
    const newClinicId = signup.body.data.clinician.clinic.id as string;
    expect(await clinicOwnerId(newClinicId)).toBe(
      member.session.clinicianId,
    );
  });

  it('기준 36·37: 강퇴자는 초대 토큰으로 같은 clinician 행을 재사용해 초대한 clinic에 합류한다', async () => {
    const owner = await createClinic('re-onboard-invitation');
    const member = await joinClinic(owner.session, 're-onboard-invitation');

    const removed = await removeMember(
      owner.session,
      member.session.clinicianId,
    );
    expect(removed.status).toBe(200);

    const invitation = await issueInvitation(owner.session);
    const callback = await socialCallback(app, member.identity);
    expect(callback.ticket).toEqual(expect.any(String));
    if (!callback.ticket) throw new Error('초대 재온보딩 티켓이 없습니다.');

    const clinicianCountBefore = await countRows(
      'SELECT count(*)::int AS count FROM clinicians',
      [],
    );
    const signup = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        ticket: callback.ticket,
        displayName: member.identity.displayName + ' 초대복귀',
        invitationToken: invitation.token,
        licenseNumber: member.identity.licenseNumber + '-INVITED',
        termsAccepted: true,
      });

    expect(signup.status).toBe(201);
    expect(signup.body.data.clinician.clinic.id).toBe(
      owner.session.clinicId,
    );
    expect(
      await countRows('SELECT count(*)::int AS count FROM clinicians', []),
    ).toBe(clinicianCountBefore);
  });

  // ── 파기 크론 회귀 ─────────────────────────────────────

  it('기준 38: 강퇴 이력이 있는 clinic을 파기하면 그 clinic의 이력은 0행이다', async () => {
    const owner = await createClinic('purge-history');
    const member = await joinClinic(owner.session, 'purge-history');

    const removed = await removeMember(
      owner.session,
      member.session.clinicianId,
    );
    expect(removed.status).toBe(200);
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM clinic_member_removals WHERE clinic_id = $1',
        [owner.session.clinicId],
      ),
    ).toBe(1);

    await markClinicPastRetention(owner.session.clinicId);
    await app.get(DataPurgeService).purge();

    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM clinic_member_removals WHERE clinic_id = $1',
        [owner.session.clinicId],
      ),
    ).toBe(0);
  });

  it('기준 39: 옛 clinic 이력이 새 clinic 개설자의 clinician·clinic 파기를 FK로 막지 않는다', async () => {
    const oldOwner = await createClinic('purge-moved-old');
    const moved = await joinClinic(oldOwner.session, 'purge-moved');

    const removed = await removeMember(
      oldOwner.session,
      moved.session.clinicianId,
    );
    expect(removed.status).toBe(200);

    const callback = await socialCallback(app, moved.identity);
    expect(callback.ticket).toEqual(expect.any(String));
    if (!callback.ticket) throw new Error('새 clinic 개설용 티켓이 없습니다.');

    const signup = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        ticket: callback.ticket,
        displayName: moved.identity.displayName + ' 이동',
        clinicName: '이동 후 한의원 ' + ulid(),
        licenseNumber: moved.identity.licenseNumber + '-MOVED',
        termsAccepted: true,
      });
    expect(signup.status).toBe(201);
    expect(signup.body.data.clinician.id).toBe(
      moved.session.clinicianId,
    );

    const newClinicId = signup.body.data.clinician.clinic.id as string;
    const movedSession: TestSession = {
      cookie: accessCookieOf(signup),
      clinicianId: moved.session.clinicianId,
      clinicId: newClinicId,
    };
    await withdraw(movedSession);

    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM clinic_member_removals WHERE clinic_id = $1 AND removed_clinician_id = $2',
        [oldOwner.session.clinicId, moved.session.clinicianId],
      ),
    ).toBe(1);
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM clinicians WHERE clinic_id = $1',
        [newClinicId],
      ),
    ).toBe(1);
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM clinics WHERE id = $1',
        [newClinicId],
      ),
    ).toBe(1);

    await markClinicPastRetention(newClinicId);
    await app.get(DataPurgeService).purge();

    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM clinicians WHERE clinic_id = $1',
        [newClinicId],
      ),
    ).toBe(0);
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM clinics WHERE id = $1',
        [newClinicId],
      ),
    ).toBe(0);
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM clinic_member_removals WHERE clinic_id = $1 AND removed_clinician_id = $2',
        [oldOwner.session.clinicId, moved.session.clinicianId],
      ),
    ).toBe(0);
  });
});
