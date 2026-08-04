// docs/specs/35 수용 기준 1~3, 5~17, 19~31 동결 테스트 — 구현 중 수정 금지
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
import request, { Response as SupertestResponse } from 'supertest';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
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
const OWNER_CLINIC_NAME = '초대공유 동결 한의원';
const GUIDELINE_QUESTION = '만성 요통 환자에게 침 치료가 효과적인가요?';
const PATIENT_GUIDANCE_QUESTION = '이 환자에게 적용할 임상 지침을 알려 주세요.';

type ConversationType = 'GUIDELINE_QA' | 'PATIENT_GUIDANCE';

interface SyntheticIdentity {
  email: string;
  providerId: string;
  displayName: string;
  licenseNumber: string;
  provider: OAuthProviderId;
}

interface IssuedInvitation {
  id: string;
  token: string;
}

interface InvitationState {
  id: string;
  token_hash: string;
  accepted_at: Date | null;
  accepted_by_clinician_id: string | null;
  revoked_at: Date | null;
}

interface PatientDto {
  id: string;
  caseLabel: string;
}

interface CompletedEvent extends SseEvent {
  message?: { id?: string; [key: string]: unknown };
  guidance?: { id?: string; [key: string]: unknown };
}

describe('docs/specs/35: 클리닉 초대·합류 + 대화 공유 전환', () => {
  jest.setTimeout(240_000);

  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let owner: TestSession;
  let otherClinicOwner: TestSession;
  let identitySequence = 0;
  let patientSequence = 0;

  const server = () => app.getHttpServer();

  const nextIdentity = (
    label: string,
    provider: OAuthProviderId = 'GOOGLE',
  ): SyntheticIdentity => {
    identitySequence += 1;
    const suffix = ulid().toLowerCase();
    return {
      email: `${label}-${identitySequence}-${suffix}@spec35.kr`,
      providerId: `spec35-${label}-${identitySequence}-${suffix}`,
      displayName: `초대동결 ${label} ${identitySequence}`,
      licenseNumber: `LIC-S35-${identitySequence}-${suffix.slice(-6)}`,
      provider,
    };
  };

  const issueInvitation = async (
    session: TestSession = owner,
  ): Promise<IssuedInvitation> => {
    const response = await request(server())
      .post('/api/v1/clinic/invitations')
      .set(CSRF)
      .set('Cookie', session.cookie)
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      data: {
        id: expect.any(String),
        token: expect.any(String),
      },
    });
    expect(response.body.data.token.length).toBeGreaterThan(0);
    return {
      id: response.body.data.id as string,
      token: response.body.data.token as string,
    };
  };

  const invitationSignupBody = async (
    invitationToken: string,
    identity: SyntheticIdentity,
  ): Promise<Record<string, unknown>> => {
    const { ticket } = await socialCallback(app, identity);
    if (!ticket) throw new Error(`신규 가입 티켓을 받지 못했습니다. (${identity.email})`);
    return {
      ticket,
      displayName: identity.displayName,
      invitationToken,
      licenseNumber: identity.licenseNumber,
      termsAccepted: true,
    };
  };

  const sessionFrom = (response: SupertestResponse): TestSession => ({
    cookie: accessCookieOf(response),
    clinicianId: response.body.data.clinician.id as string,
    clinicId: response.body.data.clinician.clinic.id as string,
  });

  const completeJoin = async (
    invitationToken: string,
    identity: SyntheticIdentity,
  ): Promise<{ response: SupertestResponse; session: TestSession }> => {
    const body = await invitationSignupBody(invitationToken, identity);
    const response = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send(body)
      .expect(201);
    return { response, session: sessionFrom(response) };
  };

  const joinOwnerClinic = (label: string): Promise<TestSession> =>
    joinByInvitation(app, owner, nextIdentity(label));

  const invitationState = async (id: string): Promise<InvitationState> => {
    const result = await pool.query<InvitationState>(
      `SELECT id, token_hash, accepted_at, accepted_by_clinician_id, revoked_at
         FROM clinic_invitations
        WHERE id = $1`,
      [id],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  };

  const clinicCount = async (): Promise<number> => {
    const result = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM clinics',
    );
    return result.rows[0].count;
  };

  const createPatient = async (
    session: TestSession = owner,
    label?: string,
  ): Promise<PatientDto> => {
    patientSequence += 1;
    const body = {
      caseLabel: label ?? `초대공유 환자 ${patientSequence}-${ulid()}`,
      birthYear: 1985,
      sex: 'FEMALE',
      heightCm: 165,
      weightKg: 60,
      waistCm: 76,
      diagnoses: ['합성 진단'],
      medications: ['합성 약물'],
      allergies: [],
      clinicalNotes: 'docs/specs/35 공유 스코프 합성 환자',
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
    title = `초대공유 대화 ${ulid()}`,
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

  const streamCompleted = async (
    session: TestSession,
    conversationId: string,
    content = GUIDELINE_QUESTION,
  ): Promise<CompletedEvent> => {
    const response = await request(server())
      .post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', session.cookie)
      .send({ content, clientRequestId: randomUUID() })
      .expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    const completed = parseSseEvents(response.text).find(
      (event) => event.eventType === 'answer.completed',
    ) as CompletedEvent | undefined;
    expect(completed).toBeDefined();
    if (!completed) throw new Error('answer.completed 이벤트를 찾지 못했습니다.');
    return completed;
  };

  const conversationDeletedAt = async (id: string): Promise<Date | null> => {
    const result = await pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM conversations WHERE id = $1',
      [id],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0].deleted_at;
  };

  beforeAll(async () => {
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

    // 대화 스트림은 프로젝트의 e2e fake LLM 경로를 타고, 가이던스 검색 자료만 합성 fixture로 넣는다.
    await app.get(GuidelineIngestService).ingest(yotongGuideline);
    owner = await socialSignUp(app, {
      email: 'spec35-owner@clinic.kr',
      providerId: 'spec35-owner',
      displayName: '초대공유 개설자',
      clinicName: OWNER_CLINIC_NAME,
      licenseNumber: 'LIC-SPEC35-OWNER',
    });
    otherClinicOwner = await socialSignUp(app, {
      email: 'spec35-foreign@clinic.kr',
      providerId: 'spec35-foreign',
      displayName: '초대공유 타 클리닉 개설자',
      clinicName: '초대공유 타 클리닉',
      licenseNumber: 'LIC-SPEC35-FOREIGN',
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await postgresContainer?.stop();
    await redisContainer?.stop();
  });

  // ── 초대 발급 ──────────────────────────────────────────

  it('기준 1: 개설자의 초대 발급은 201이고 원문 token을 유일 노출 응답에 담는다', async () => {
    const issued = await issueInvitation(owner);

    expect(issued.token).toEqual(expect.any(String));
    expect(issued.token.length).toBeGreaterThan(0);
  });

  it('기준 2: 발급 token 원문은 초대 행 어느 텍스트 컬럼에도 없고 token_hash만 채워진다', async () => {
    const issued = await issueInvitation(owner);
    const result = await pool.query<Record<string, unknown>>(
      'SELECT * FROM clinic_invitations WHERE id = $1',
      [issued.id],
    );
    expect(result.rows).toHaveLength(1);

    for (const value of Object.values(result.rows[0])) {
      if (typeof value === 'string') expect(value).not.toContain(issued.token);
    }
    expect(result.rows[0].token_hash).toEqual(expect.any(String));
    expect((result.rows[0].token_hash as string).length).toBeGreaterThan(0);
    expect(result.rows[0].token_hash).not.toBe(issued.token);
  });

  it('기준 3: 합류 구성원은 초대를 발급할 수 없고 개설자만 201이다', async () => {
    const member = await joinOwnerClinic('non-owner-issue');

    // 양성 대조: 같은 라우트는 개설자에게 실제로 열려 있다.
    await issueInvitation(owner);
    const denied = await request(server())
      .post('/api/v1/clinic/invitations')
      .set(CSRF)
      .set('Cookie', member.cookie)
      .expect(403);

    expect(denied.body.code).toBe('FORBIDDEN');
  });

  // ── 목록·취소 ──────────────────────────────────────────

  it('기준 5·6: 목록에는 자기 클리닉 초대만 있고 어느 항목에도 token이 없다', async () => {
    const owned = await issueInvitation(owner);
    const foreign = await issueInvitation(otherClinicOwner);

    const response = await request(server())
      .get('/api/v1/clinic/invitations')
      .query({ size: 100 })
      .set('Cookie', owner.cookie)
      .expect(200);
    const items = response.body.data as Array<{ id: string; token?: unknown }>;

    expect(items.map((item) => item.id)).toContain(owned.id);
    expect(items.map((item) => item.id)).not.toContain(foreign.id);
    for (const item of items) expect(item.token).toBeUndefined();
  });

  it('기준 7: 합류 구성원은 초대 목록을 볼 수 없고 개설자만 200이다', async () => {
    const member = await joinOwnerClinic('non-owner-list');

    await request(server())
      .get('/api/v1/clinic/invitations')
      .set('Cookie', owner.cookie)
      .expect(200);
    const denied = await request(server())
      .get('/api/v1/clinic/invitations')
      .set('Cookie', member.cookie)
      .expect(403);

    expect(denied.body.code).toBe('FORBIDDEN');
  });

  it('기준 8: 자기 초대 취소는 200으로 revoked_at을 채우지만 타 클리닉 초대는 404와 무변경이다', async () => {
    const ownedControl = await issueInvitation(owner);
    const foreign = await issueInvitation(otherClinicOwner);

    // 필수 양성 대조군: DELETE 라우트가 구현되어 실제 상태를 바꾸는지 먼저 고정한다.
    await request(server())
      .delete(`/api/v1/clinic/invitations/${ownedControl.id}`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect((await invitationState(ownedControl.id)).revoked_at).not.toBeNull();

    const hidden = await request(server())
      .delete(`/api/v1/clinic/invitations/${foreign.id}`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .expect(404);
    expect(hidden.body.code).toBe('NOT_FOUND');
    expect((await invitationState(foreign.id)).revoked_at).toBeNull();
  });

  it('기준 9: 취소 전 프리뷰는 200이지만 취소된 token은 404 INVITATION_INVALID다', async () => {
    const activeControl = await issueInvitation(owner);
    await request(server())
      .get(`/api/v1/invitations/${encodeURIComponent(activeControl.token)}`)
      .expect(200);

    const revoked = await issueInvitation(owner);
    // 같은 token의 취소 전 정상 응답도 확인해 미존재 token을 시험한 것이 아님을 보장한다.
    await request(server())
      .get(`/api/v1/invitations/${encodeURIComponent(revoked.token)}`)
      .expect(200);
    await request(server())
      .delete(`/api/v1/clinic/invitations/${revoked.id}`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .expect(200);

    const invalid = await request(server())
      .get(`/api/v1/invitations/${encodeURIComponent(revoked.token)}`)
      .expect(404);
    expect(invalid.body.code).toBe('INVITATION_INVALID');
  });

  // ── 비인증 프리뷰 ──────────────────────────────────────

  it('기준 10·11: 쿠키 없는 프리뷰는 clinicName만 200으로 공개한다', async () => {
    const issued = await issueInvitation(owner);

    const response = await request(server())
      .get(`/api/v1/invitations/${encodeURIComponent(issued.token)}`)
      // 의도적으로 Cookie 헤더를 두지 않는다.
      .expect(200);

    expect(response.body.data.clinicName).toBe(OWNER_CLINIC_NAME);
    expect(Object.keys(response.body.data).sort()).toEqual(['clinicName']);
    expect(response.body.data.clinicId).toBeUndefined();
    expect(response.body.data.invitationId).toBeUndefined();
    for (const key of ['email', 'displayName', 'invitedBy', 'invitedByClinicianId']) {
      expect(response.body.data[key]).toBeUndefined();
    }
  });

  // ── 합류 ────────────────────────────────────────────────

  it('기준 12·13·15·19·20: 합류는 새 clinic 없이 같은 clinic의 MEMBER를 만들고 초대만 소비한다', async () => {
    const issued = await issueInvitation(owner);
    const identity = nextIdentity('join-state');
    const signupBody = await invitationSignupBody(issued.token, identity);
    const clinicsBefore = await clinicCount();

    const response = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send(signupBody)
      .expect(201);
    const joined = sessionFrom(response);

    expect(await clinicCount()).toBe(clinicsBefore);
    expect(response.body.data.clinician.clinic.id).toBe(owner.clinicId);
    expect(joined.clinicId).toBe(owner.clinicId);

    const invitation = await invitationState(issued.id);
    expect(invitation.accepted_at).not.toBeNull();
    expect(invitation.accepted_by_clinician_id).toBe(joined.clinicianId);

    const clinician = await pool.query<{ role: string; clinic_id: string }>(
      'SELECT role, clinic_id FROM clinicians WHERE id = $1',
      [joined.clinicianId],
    );
    expect(clinician.rows).toEqual([{ role: 'MEMBER', clinic_id: owner.clinicId }]);

    const clinic = await pool.query<{ owner_clinician_id: string | null }>(
      'SELECT owner_clinician_id FROM clinics WHERE id = $1',
      [owner.clinicId],
    );
    expect(clinic.rows).toEqual([{ owner_clinician_id: owner.clinicianId }]);
  });

  it('기준 14: invitationToken과 clinicName을 함께 보낸 모순된 signup은 422다', async () => {
    const issued = await issueInvitation(owner);
    const body = await invitationSignupBody(issued.token, nextIdentity('ambiguous-signup'));

    const response = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({ ...body, clinicName: '조용히 무시하면 안 되는 한의원명' })
      .expect(422);

    expect(response.body.success).toBe(false);
  });

  it('기준 16: 첫 합류는 201이지만 같은 token을 새 signup 티켓으로 재사용하면 404 INVITATION_INVALID다', async () => {
    const issued = await issueInvitation(owner);

    // 필수 양성 대조군: 같은 초대 token의 첫 소비가 실제로 성공한다.
    await completeJoin(issued.token, nextIdentity('one-time-first'));
    const secondBody = await invitationSignupBody(
      issued.token,
      nextIdentity('one-time-second'),
    );
    const reused = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send(secondBody)
      .expect(404);

    expect(reused.body.code).toBe('INVITATION_INVALID');
  });

  it('기준 17: 이미 가입된 이메일은 409 AUTH_EMAIL_ALREADY_USED이고 초대를 소비하지 않는다', async () => {
    const issued = await issueInvitation(owner);
    const existing = nextIdentity('already-used', 'GOOGLE');
    await socialSignUp(app, {
      ...existing,
      clinicName: `기소속 독립 한의원 ${ulid()}`,
    });

    // 같은 이메일이지만 다른 소셜 제공자 계정이라 신규 signup 티켓까지는 발급된다.
    const duplicate: SyntheticIdentity = {
      ...nextIdentity('duplicate-oauth', 'NAVER'),
      email: existing.email,
    };
    const body = await invitationSignupBody(issued.token, duplicate);
    const rejected = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send(body)
      .expect(409);

    expect(rejected.body.code).toBe('AUTH_EMAIL_ALREADY_USED');
    expect((await invitationState(issued.id)).accepted_at).toBeNull();
  });

  // ── 같은 클리닉 공유 ───────────────────────────────────

  it('기준 21·22·23: 개설자 대화는 합류자의 목록·상세·메시지 목록에서 모두 200으로 보인다', async () => {
    const member = await joinOwnerClinic('shared-read');
    const conversationId = await createConversation({ session: owner });

    const list = await request(server())
      .get('/api/v1/conversations')
      .query({ size: 100 })
      .set('Cookie', member.cookie)
      .expect(200);
    expect((list.body.data as Array<{ id: string }>).map((item) => item.id)).toContain(
      conversationId,
    );

    const detail = await request(server())
      .get(`/api/v1/conversations/${conversationId}`)
      .set('Cookie', member.cookie)
      .expect(200);
    expect(detail.body.data.id).toBe(conversationId);

    const messages = await request(server())
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set('Cookie', member.cookie)
      .expect(200);
    expect(messages.body.success).toBe(true);
  });

  it('기준 24: 합류자는 개설자 대화에 이어 질문하고 SSE answer.completed까지 도달한다', async () => {
    const member = await joinOwnerClinic('shared-stream');
    const conversationId = await createConversation({ session: owner });

    const completed = await streamCompleted(member, conversationId);

    expect(completed.eventType).toBe('answer.completed');
    expect(completed.message?.id).toEqual(expect.any(String));
  });

  it('기준 25: 합류자는 개설자 대화 이름을 PATCH로 바꿀 수 있다', async () => {
    const member = await joinOwnerClinic('shared-rename');
    const conversationId = await createConversation({ session: owner });
    const title = `합류자가 바꾼 이름 ${ulid()}`;

    const response = await request(server())
      .patch(`/api/v1/conversations/${conversationId}`)
      .set(CSRF)
      .set('Cookie', member.cookie)
      .send({ title })
      .expect(200);

    expect(response.body.data).toMatchObject({ id: conversationId, title });
  });

  it('기준 26: 합류자는 개설자 대화를 200으로 삭제하고 deleted_at을 채운다', async () => {
    const member = await joinOwnerClinic('shared-delete');
    const conversationId = await createConversation({ session: owner });

    const response = await request(server())
      .delete(`/api/v1/conversations/${conversationId}`)
      .set(CSRF)
      .set('Cookie', member.cookie)
      .expect(200);

    expect(response.body).toMatchObject({ success: true, data: null });
    expect(await conversationDeletedAt(conversationId)).not.toBeNull();
  });

  it('기준 27: 개설자가 등록한 환자는 합류자에게도 200으로 보인다', async () => {
    const member = await joinOwnerClinic('shared-patient');
    const patient = await createPatient(owner);

    const response = await request(server())
      .get(`/api/v1/patients/${patient.id}`)
      .set('Cookie', member.cookie)
      .expect(200);

    expect(response.body.data.id).toBe(patient.id);
  });

  it('기준 28: 개설자 대화에 딸린 가이던스는 합류자에게도 200으로 보인다', async () => {
    const member = await joinOwnerClinic('shared-guidance');
    const patient = await createPatient(owner);
    const conversationId = await createConversation({
      session: owner,
      type: 'PATIENT_GUIDANCE',
      patientId: patient.id,
    });
    const completed = await streamCompleted(
      owner,
      conversationId,
      PATIENT_GUIDANCE_QUESTION,
    );
    const guidanceId = completed.guidance?.id;
    expect(guidanceId).toEqual(expect.any(String));
    if (!guidanceId) throw new Error('합성 임상 가이던스 id가 없습니다.');

    const response = await request(server())
      .get(`/api/v1/clinical-guidance/${guidanceId}`)
      .set('Cookie', member.cookie)
      .expect(200);
    expect(response.body.data.id).toBe(guidanceId);
  });

  it('기준 29: 같은 클리닉 GET·DELETE는 200이지만 타 클리닉 대화 GET·DELETE는 모두 404다', async () => {
    const member = await joinOwnerClinic('clinic-boundary');
    const readableControl = await createConversation({ session: owner });
    const deletableControl = await createConversation({ session: owner });
    const foreignConversation = await createConversation({ session: otherClinicOwner });

    // GET과 DELETE 각각의 필수 양성 대조군.
    await request(server())
      .get(`/api/v1/conversations/${readableControl}`)
      .set('Cookie', member.cookie)
      .expect(200);
    await request(server())
      .delete(`/api/v1/conversations/${deletableControl}`)
      .set(CSRF)
      .set('Cookie', member.cookie)
      .expect(200);

    const hiddenGet = await request(server())
      .get(`/api/v1/conversations/${foreignConversation}`)
      .set('Cookie', member.cookie)
      .expect(404);
    expect(hiddenGet.body.code).toBe('NOT_FOUND');

    const hiddenDelete = await request(server())
      .delete(`/api/v1/conversations/${foreignConversation}`)
      .set(CSRF)
      .set('Cookie', member.cookie)
      .expect(404);
    expect(hiddenDelete.body.code).toBe('NOT_FOUND');
    expect(await conversationDeletedAt(foreignConversation)).toBeNull();
  });

  it('기준 30: 같은 메시지에 개설자와 합류자가 각각 201 피드백을 남기며 DB에는 2행이다', async () => {
    const member = await joinOwnerClinic('per-member-feedback');
    const conversationId = await createConversation({ session: owner });
    const completed = await streamCompleted(owner, conversationId);
    const messageId = completed.message?.id;
    expect(messageId).toEqual(expect.any(String));
    if (!messageId) throw new Error('합성 답변 메시지 id가 없습니다.');

    await request(server())
      .post(`/api/v1/messages/${messageId}/feedback`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .send({ rating: 'HELPFUL', comment: '개설자 피드백' })
      .expect(201);
    await request(server())
      .post(`/api/v1/messages/${messageId}/feedback`)
      .set(CSRF)
      .set('Cookie', member.cookie)
      .send({ rating: 'HELPFUL', comment: '합류자 피드백' })
      .expect(201);

    const feedbacks = await pool.query<{ clinician_id: string }>(
      `SELECT clinician_id
         FROM answer_feedbacks
        WHERE message_id = $1
        ORDER BY clinician_id`,
      [messageId],
    );
    expect(feedbacks.rows).toHaveLength(2);
    expect(feedbacks.rows.map((row) => row.clinician_id).sort()).toEqual(
      [owner.clinicianId, member.clinicianId].sort(),
    );
  });

  it('기준 31: 합류자가 삭제한 개설자 대화는 개설자의 목록과 상세에서도 사라진다', async () => {
    const member = await joinOwnerClinic('shared-deleted-hidden');
    const deletedConversation = await createConversation({ session: owner });
    const liveControl = await createConversation({ session: owner });

    await request(server())
      .delete(`/api/v1/conversations/${deletedConversation}`)
      .set(CSRF)
      .set('Cookie', member.cookie)
      .expect(200);
    expect(await conversationDeletedAt(deletedConversation)).not.toBeNull();

    const list = await request(server())
      .get('/api/v1/conversations')
      .query({ size: 100 })
      .set('Cookie', owner.cookie)
      .expect(200);
    const ids = (list.body.data as Array<{ id: string }>).map((item) => item.id);
    expect(ids).toContain(liveControl);
    expect(ids).not.toContain(deletedConversation);

    // 상세 404의 필수 양성 대조군: 삭제하지 않은 같은 경로는 200이다.
    await request(server())
      .get(`/api/v1/conversations/${liveControl}`)
      .set('Cookie', owner.cookie)
      .expect(200);
    const hidden = await request(server())
      .get(`/api/v1/conversations/${deletedConversation}`)
      .set('Cookie', owner.cookie)
      .expect(404);
    expect(hidden.body.code).toBe('NOT_FOUND');
  });
});
