// docs/specs/37 수용 기준 1~18·20~21 동결 테스트 — 구현 중 수정 금지
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request, { Response as SupertestResponse } from 'supertest';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import type { OAuthProviderId } from '../src/infrastructure/oauth/oauth-provider.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import {
  accessCookieOf,
  joinByInvitation,
  socialCallback,
  socialSignUp,
  type TestSession,
} from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const WEB_BASE_URL = 'http://localhost:3001';

interface SyntheticIdentity {
  email: string;
  providerId: string;
  provider: OAuthProviderId;
  displayName: string;
  clinicName: string;
  licenseNumber: string;
}

interface IssuedInvitation {
  id: string;
  token: string;
}

describe('docs/specs/37: 소셜 계정 기준 가입 — 이메일 unique 해제', () => {
  jest.setTimeout(240_000);

  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let identitySequence = 0;

  const server = () => app.getHttpServer();

  const syntheticEmail = (label: string): string =>
    `${label}-${ulid().toLowerCase()}@spec37.test`;

  const nextIdentity = (
    label: string,
    provider: OAuthProviderId,
    email = syntheticEmail(label),
  ): SyntheticIdentity => {
    identitySequence += 1;
    const suffix = ulid().toLowerCase();
    return {
      email,
      provider,
      providerId: `spec37-${provider.toLowerCase()}-${identitySequence}-${suffix}`,
      displayName: `spec37 ${label} ${identitySequence}`,
      clinicName: `spec37 ${label} 한의원`,
      licenseNumber: `LIC-S37-${identitySequence}-${suffix.slice(-6)}`,
    };
  };

  const sameEmailPair = (
    label: string,
  ): { first: SyntheticIdentity; second: SyntheticIdentity } => {
    const email = syntheticEmail(label);
    return {
      first: nextIdentity(`${label}-first`, 'GOOGLE', email),
      second: nextIdentity(`${label}-second`, 'KAKAO', email),
    };
  };

  const clinicCount = async (): Promise<number> => {
    const result = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM clinics',
    );
    return result.rows[0].count;
  };

  const issueInvitation = async (owner: TestSession): Promise<IssuedInvitation> => {
    const response = await request(server())
      .post('/api/v1/clinic/invitations')
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .expect(201);

    const id: unknown = response.body.data?.id;
    const token: unknown = response.body.data?.token;
    if (typeof id !== 'string' || typeof token !== 'string' || token.length === 0) {
      throw new Error('초대 발급 응답에 id 또는 token이 없습니다.');
    }
    return { id, token };
  };

  const invitationSignupResponse = async (
    invitation: IssuedInvitation,
    identity: SyntheticIdentity,
  ): Promise<SupertestResponse> => {
    const { ticket } = await socialCallback(app, identity);
    if (!ticket) throw new Error(`신규 가입 티켓을 받지 못했습니다. (${identity.email})`);

    return request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        ticket,
        displayName: identity.displayName,
        invitationToken: invitation.token,
        licenseNumber: identity.licenseNumber,
        termsAccepted: true,
      });
  };

  const sessionFrom = (response: SupertestResponse): TestSession => ({
    cookie: accessCookieOf(response),
    clinicianId: response.body.data.clinician.id as string,
    clinicId: response.body.data.clinician.clinic.id as string,
  });

  const joinIssuedInvitation = async (
    invitation: IssuedInvitation,
    identity: SyntheticIdentity,
  ): Promise<TestSession> => {
    const response = await invitationSignupResponse(invitation, identity);
    if (response.status !== 201) {
      throw new Error(
        `초대 signup이 201이 아닙니다. status=${response.status} body=${JSON.stringify(response.body)}`,
      );
    }
    return sessionFrom(response);
  };

  const crossClinicDuplicateScenario = async (
    label: string,
  ): Promise<{
    owner: TestSession;
    invitation: IssuedInvitation;
    joiningIdentity: SyntheticIdentity;
  }> => {
    const owner = await socialSignUp(app, nextIdentity(`${label}-owner`, 'NAVER'));
    const sharedEmail = syntheticEmail(`${label}-shared`);
    await socialSignUp(
      app,
      nextIdentity(`${label}-existing`, 'GOOGLE', sharedEmail),
    );
    const invitation = await issueInvitation(owner);
    const joiningIdentity = nextIdentity(`${label}-joining`, 'KAKAO', sharedEmail);
    return { owner, invitation, joiningIdentity };
  };

  const sameClinicDuplicateScenario = async (
    label: string,
  ): Promise<{
    owner: TestSession;
    sharedEmail: string;
    duplicateIdentity: SyntheticIdentity;
  }> => {
    const owner = await socialSignUp(app, nextIdentity(`${label}-owner`, 'NAVER'));
    const sharedEmail = syntheticEmail(`${label}-members`);
    await joinByInvitation(
      app,
      owner,
      nextIdentity(`${label}-first-member`, 'GOOGLE', sharedEmail),
    );
    return {
      owner,
      sharedEmail,
      duplicateIdentity: nextIdentity(`${label}-second-member`, 'KAKAO', sharedEmail),
    };
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
      // signup은 60초당 20회로 제한되는데(auth.controller.ts의 @Throttle) 이 스위트는 시나리오마다
      // 2~3회씩 40회 넘게 부른다. 가입 폭주 방어는 이 스펙의 검증 대상이 아니므로 여기서만 끈다 —
      // 429가 섞이면 구현이 옳아도 통과할 수 없다 (clinician-withdrawal.e2e-spec.ts와 같은 이유).
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
  });

  // ── 같은 이메일 · 다른 소셜 — 독립 가입 ───────────────

  it('기준 1: 같은 이메일의 다른 provider signup은 201이다', async () => {
    const { first, second } = sameEmailPair('criterion-1');
    await socialSignUp(app, first);
    const { ticket } = await socialCallback(app, second);
    if (!ticket) throw new Error('두 번째 소셜 계정의 신규 가입 티켓이 없습니다.');

    const response = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        ticket,
        displayName: second.displayName,
        clinicName: second.clinicName,
        licenseNumber: second.licenseNumber,
        termsAccepted: true,
      });

    expect(response.status).toBe(201);
  });

  it('기준 2: 같은 이메일로 가입한 두 소셜 계정의 clinicianId는 서로 다르다', async () => {
    const { first, second } = sameEmailPair('criterion-2');
    const firstSession = await socialSignUp(app, first);
    const secondSession = await socialSignUp(app, second);

    expect(secondSession.clinicianId).not.toBe(firstSession.clinicianId);
  });

  it('기준 3: 같은 이메일로 가입한 두 소셜 계정의 clinicId는 서로 다르다', async () => {
    const { first, second } = sameEmailPair('criterion-3');
    const firstSession = await socialSignUp(app, first);
    const secondSession = await socialSignUp(app, second);

    expect(secondSession.clinicId).not.toBe(firstSession.clinicId);
  });

  it('기준 4: 같은 이메일의 두 번째 독립 가입은 clinics 총 건수를 정확히 1 늘린다', async () => {
    const { first, second } = sameEmailPair('criterion-4');
    await socialSignUp(app, first);
    const before = await clinicCount();
    await socialSignUp(app, second);
    const after = await clinicCount();

    expect(after - before).toBe(1);
  });

  it('기준 5: clinicians에는 같은 이메일을 가진 행이 정확히 2개 존재한다', async () => {
    const { first, second } = sameEmailPair('criterion-5');
    await socialSignUp(app, first);
    await socialSignUp(app, second);

    const result = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM clinicians WHERE email = $1',
      [first.email],
    );
    expect(result.rows[0].count).toBe(2);
  });

  it('기준 6: 첫 계정 쿠키의 GET /auth/me는 첫 clinicianId를 돌려준다', async () => {
    const { first, second } = sameEmailPair('criterion-6');
    const firstSession = await socialSignUp(app, first);
    await socialSignUp(app, second);

    const me = await request(server())
      .get('/api/v1/auth/me')
      .set('Cookie', firstSession.cookie);
    expect(me.body.data?.id).toBe(firstSession.clinicianId);
  });

  it('기준 7: 둘째 계정 쿠키의 GET /auth/me는 둘째 clinicianId를 돌려준다', async () => {
    const { first, second } = sameEmailPair('criterion-7');
    await socialSignUp(app, first);
    const secondSession = await socialSignUp(app, second);

    const me = await request(server())
      .get('/api/v1/auth/me')
      .set('Cookie', secondSession.cookie);
    expect(me.body.data?.id).toBe(secondSession.clinicianId);
  });

  // ── 소셜 계정 unique 회귀 ──────────────────────────────

  it('기준 8: 같은 provider와 providerId의 기존 계정 콜백은 ticket이 null이다', async () => {
    const identity = nextIdentity('criterion-8', 'GOOGLE');
    await socialSignUp(app, identity);

    const { ticket } = await socialCallback(app, identity);
    expect(ticket).toBeNull();
  });

  it('기준 9: 같은 provider와 providerId의 기존 계정 콜백은 쿠키를 발급하고 /assistant로 리다이렉트한다', async () => {
    const identity = nextIdentity('criterion-9', 'KAKAO');
    await socialSignUp(app, identity);

    const { location, response } = await socialCallback(app, identity);
    expect({
      location,
      accessCookieIssued: accessCookieOf(response).startsWith('access_token='),
    }).toEqual({
      location: `${WEB_BASE_URL}/assistant`,
      accessCookieIssued: true,
    });
  });

  // ── 초대 합류 ──────────────────────────────────────────

  it('기준 10: 같은 이메일의 다른 소셜 계정이 초대 token으로 signup하면 201이다', async () => {
    const { invitation, joiningIdentity } = await crossClinicDuplicateScenario(
      'criterion-10',
    );

    const response = await invitationSignupResponse(invitation, joiningIdentity);
    expect(response.status).toBe(201);
  });

  it('기준 11: 같은 이메일의 다른 소셜 계정이 초대로 합류해도 clinics 총 건수는 불변이다', async () => {
    const { invitation, joiningIdentity } = await crossClinicDuplicateScenario(
      'criterion-11',
    );
    const before = await clinicCount();
    await joinIssuedInvitation(invitation, joiningIdentity);
    const after = await clinicCount();

    expect(after).toBe(before);
  });

  it('기준 12: 같은 이메일의 다른 소셜 계정 합류자는 초대한 개설자와 같은 clinicId를 갖는다', async () => {
    const { owner, invitation, joiningIdentity } =
      await crossClinicDuplicateScenario('criterion-12');
    const joined = await joinIssuedInvitation(invitation, joiningIdentity);

    expect(joined.clinicId).toBe(owner.clinicId);
  });

  it('기준 13: 같은 이메일의 다른 소셜 계정 합류가 소비한 초대는 accepted_at이 채워진다', async () => {
    const { invitation, joiningIdentity } = await crossClinicDuplicateScenario(
      'criterion-13',
    );
    await joinIssuedInvitation(invitation, joiningIdentity);

    const result = await pool.query<{ accepted_at: Date | null }>(
      'SELECT accepted_at FROM clinic_invitations WHERE id = $1',
      [invitation.id],
    );
    expect(result.rows[0]?.accepted_at ?? null).not.toBeNull();
  });

  it('기준 14: 클리닉 기존 구성원과 같은 이메일인 다른 소셜 계정의 초대 합류는 201이다', async () => {
    const { owner, duplicateIdentity } = await sameClinicDuplicateScenario(
      'criterion-14',
    );

    await joinByInvitation(app, owner, duplicateIdentity);
  });

  it('기준 15: 한 클리닉에 같은 이메일을 가진 clinicians 행이 정확히 2건 존재한다', async () => {
    const { owner, sharedEmail, duplicateIdentity } =
      await sameClinicDuplicateScenario('criterion-15');
    await joinByInvitation(app, owner, duplicateIdentity);

    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM clinicians
        WHERE clinic_id = $1 AND email = $2`,
      [owner.clinicId, sharedEmail],
    );
    expect(result.rows[0].count).toBe(2);
  });

  // ── 스키마 ─────────────────────────────────────────────

  it('기준 16: pg_indexes에 uq_clinicians_email이 없다', async () => {
    const result = await pool.query(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'clinicians'
          AND indexname = 'uq_clinicians_email'`,
    );

    expect(result.rows).toHaveLength(0);
  });

  it('기준 17: pg_indexes에 uq_clinicians_oauth가 있다', async () => {
    const result = await pool.query(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'clinicians'
          AND indexname = 'uq_clinicians_oauth'`,
    );

    expect(result.rows).toHaveLength(1);
  });

  it("기준 18: clinicians.email의 is_nullable은 'NO'다", async () => {
    const result = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'clinicians'
          AND column_name = 'email'`,
    );

    expect(result.rows[0]?.is_nullable ?? null).toBe('NO');
  });

  // ── §36 회귀 ───────────────────────────────────────────

  it('기준 20: 탈퇴 후 clinicians.email은 원본과 다른 값으로 덮인다', async () => {
    const identity = nextIdentity('criterion-20', 'GOOGLE');
    const session = await socialSignUp(app, identity);

    await request(server())
      .delete('/api/v1/auth/me')
      .set(CSRF)
      .set('Cookie', session.cookie);

    const result = await pool.query<{ email: string }>(
      'SELECT email FROM clinicians WHERE id = $1',
      [session.clinicianId],
    );
    expect(result.rows[0]?.email ?? identity.email).not.toBe(identity.email);
  });

  it('기준 21: 탈퇴 후 같은 소셜 계정의 콜백은 신규 가입 ticket을 발급한다', async () => {
    const identity = nextIdentity('criterion-21', 'NAVER');
    const session = await socialSignUp(app, identity);

    await request(server())
      .delete('/api/v1/auth/me')
      .set(CSRF)
      .set('Cookie', session.cookie);

    const { ticket } = await socialCallback(app, identity);
    expect(ticket).not.toBeNull();
  });
});
