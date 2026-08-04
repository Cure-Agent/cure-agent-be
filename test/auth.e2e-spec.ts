import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request, { Response as SupertestResponse } from 'supertest';
import { AppModule } from '../src/app.module';
import { RealTimeAlertSender } from '../src/global/observability/real-time-alert.sender';
import { AesGcmUtil } from '../src/global/security/crypto/aes-gcm.util';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { FakeOAuthProviderRegistry, encodeFakeCode } from './fixtures/fake-oauth';
import { socialCallback, socialSignUp } from './fixtures/social-auth';
import { bootstrapApp } from './fixtures/app-bootstrap';

const CSRF = { 'X-CSRF-Protection': '1' };
const WEB_BASE_URL = 'http://localhost:3001';

/** Set-Cookie 헤더에서 {이름: {value, raw}} 맵 추출 */
function cookiesOf(res: SupertestResponse): Record<string, { value: string; raw: string }> {
  const headers = (res.headers['set-cookie'] ?? []) as unknown as string[];
  return Object.fromEntries(
    headers.map((raw) => {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      return [pair.slice(0, eq), { value: pair.slice(eq + 1), raw }];
    }),
  );
}

describe('Auth — 소셜 로그인 (Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  const alertSender = { send: jest.fn() };

  beforeAll(async () => {
    [container, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RealTimeAlertSender)
      .useValue(alertSender)
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  beforeEach(() => {
    alertSender.send.mockClear();
  });

  const server = () => app.getHttpServer();

  // ── 소셜 로그인 진입 ────────────────────────────────────

  it('providers: 활성 제공자 목록을 내려준다', async () => {
    const res = await request(server()).get('/api/v1/auth/oauth/providers').expect(200);
    expect(res.body.data.providers).toEqual(
      expect.arrayContaining(['GOOGLE', 'KAKAO', 'NAVER']),
    );
  });

  it('start: 동의 화면으로 302 + state 쿠키 발급 (HttpOnly, 경로 한정)', async () => {
    const res = await request(server()).get('/api/v1/auth/oauth/google').expect(302);

    const state = cookiesOf(res).oauth_state;
    expect(state).toBeDefined();
    expect(state.raw).toContain('HttpOnly');
    expect(state.raw).toContain('SameSite=Lax');
    expect(state.raw).toContain('Path=/api/v1/auth/oauth');

    const location = new URL(res.headers.location);
    expect(location.searchParams.get('state')).toBe(state.value);
    expect(location.searchParams.get('redirect_uri')).toBe(
      `${WEB_BASE_URL}/api/v1/auth/oauth/google/callback`,
    );
  });

  it('start: 미지원 제공자 → 로그인 페이지로 에러 리다이렉트', async () => {
    const res = await request(server()).get('/api/v1/auth/oauth/facebook').expect(302);
    expect(res.headers.location).toBe(
      `${WEB_BASE_URL}/login?error=AUTH_OAUTH_PROVIDER_UNSUPPORTED`,
    );
  });

  // ── 콜백 분기 ───────────────────────────────────────────

  it('callback(신규): 계정을 만들지 않고 티켓만 발급 후 온보딩 페이지로 302', async () => {
    const { location, ticket, response } = await socialCallback(app, {
      email: 'new@clinic.kr',
      providerId: 'google-1001',
    });

    expect(location.startsWith(`${WEB_BASE_URL}/signup?`)).toBe(true);
    expect(ticket).toEqual(expect.any(String));
    // 온보딩 전에는 인증 쿠키가 나가지 않는다
    expect(cookiesOf(response).access_token).toBeUndefined();

    const { rows } = await pool.query(
      "SELECT 1 FROM clinicians WHERE email = 'new@clinic.kr'",
    );
    expect(rows).toHaveLength(0);
  });

  it('callback(기존): provider+providerId로 식별해 바로 로그인 쿠키 발급', async () => {
    await socialSignUp(app, { email: 'returning@clinic.kr', providerId: 'google-2002' });

    // 이메일이 바뀌어도 providerId가 같으면 같은 계정이다
    const { location, response } = await socialCallback(app, {
      email: 'changed-address@clinic.kr',
      providerId: 'google-2002',
    });

    expect(location).toBe(`${WEB_BASE_URL}/assistant`);
    const cookies = cookiesOf(response);
    for (const name of ['access_token', 'refresh_token']) {
      expect(cookies[name].raw).toContain('HttpOnly');
      expect(cookies[name].raw).toContain('SameSite=Lax');
    }

    const me = await request(server())
      .get('/api/v1/auth/me')
      .set('Cookie', `access_token=${cookies.access_token.value}`)
      .expect(200);
    expect(me.body.data.email).toBe('returning@clinic.kr');
  });

  it('callback: state 불일치 → 로그인 페이지로 AUTH_OAUTH_STATE_MISMATCH', async () => {
    const started = await request(server()).get('/api/v1/auth/oauth/google').expect(302);
    const stateCookie = cookiesOf(started).oauth_state;

    const res = await request(server())
      .get('/api/v1/auth/oauth/google/callback')
      .query({ code: encodeFakeCode({ providerId: 'x', email: 'x@x.kr', displayName: null }) })
      .query({ state: 'forged-state' })
      .set('Cookie', `oauth_state=${stateCookie.value}`)
      .expect(302);

    expect(res.headers.location).toBe(
      `${WEB_BASE_URL}/login?error=AUTH_OAUTH_STATE_MISMATCH`,
    );
  });

  it('callback: 동의 취소(error 파라미터) → AUTH_OAUTH_DENIED', async () => {
    const res = await request(server())
      .get('/api/v1/auth/oauth/google/callback')
      .query({ error: 'access_denied' })
      .expect(302);
    expect(res.headers.location).toBe(`${WEB_BASE_URL}/login?error=AUTH_OAUTH_DENIED`);
  });

  it('callback: 이메일 미동의 신규 사용자 → AUTH_OAUTH_EMAIL_MISSING', async () => {
    const { location } = await socialCallback(app, {
      email: null,
      providerId: 'kakao-no-email',
      provider: 'KAKAO',
    });
    expect(location).toBe(`${WEB_BASE_URL}/login?error=AUTH_OAUTH_EMAIL_MISSING`);
  });

  // ── 온보딩 완료 ─────────────────────────────────────────

  it('signup: 201 CREATED + HttpOnly 쿠키 발급 + PENDING 상태', async () => {
    const { ticket } = await socialCallback(app, {
      email: 'signup@clinic.kr',
      providerId: 'google-3003',
      displayName: '구글이름',
    });

    const res = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        ticket,
        displayName: '김의사',
        clinicName: '서울한의원',
        licenseNumber: 'LIC-0042',
        termsAccepted: true,
      })
      .expect(201);

    expect(res.body.code).toBe('CREATED');
    expect(res.body.data.clinician).toMatchObject({
      email: 'signup@clinic.kr', // 이메일은 바디가 아니라 티켓에서 나온다
      displayName: '김의사',
      verificationStatus: 'PENDING',
      clinic: expect.objectContaining({ name: '서울한의원' }),
    });
    expect(new Date(res.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const cookies = cookiesOf(res);
    for (const name of ['access_token', 'refresh_token']) {
      expect(cookies[name]).toBeDefined();
      expect(cookies[name].raw).toContain('HttpOnly');
      expect(cookies[name].raw).toContain('SameSite=Lax');
      expect(cookies[name].raw).toContain('Path=/');
    }
  });

  it('signup: 면허번호는 DB에 키버전 포함 암호문으로만 저장된다 (§4.5)', async () => {
    await socialSignUp(app, { email: 'license@clinic.kr', providerId: 'google-4004' });

    const { rows } = await pool.query(
      "SELECT license_number_encrypted FROM clinicians WHERE email = 'license@clinic.kr'",
    );
    const stored: string = rows[0].license_number_encrypted;
    expect(stored).not.toContain('LIC-0042');
    expect(stored.startsWith('v1.')).toBe(true);
    expect(app.get(AesGcmUtil).decrypt(stored)).toBe('LIC-0042');
  });

  it('signup: 티켓은 1회용 — 재사용 시 401 AUTH_OAUTH_TICKET_INVALID', async () => {
    const { ticket } = await socialCallback(app, {
      email: 'once@clinic.kr',
      providerId: 'google-5005',
    });
    const body = {
      ticket,
      displayName: '김의사',
      clinicName: '서울한의원',
      licenseNumber: 'LIC-0042',
      termsAccepted: true,
    };

    await request(server()).post('/api/v1/auth/signup').set(CSRF).send(body).expect(201);

    const reused = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send(body)
      .expect(401);
    expect(reused.body.code).toBe('AUTH_OAUTH_TICKET_INVALID');
  });

  it('signup: 위조·만료 티켓 → 401 AUTH_OAUTH_TICKET_INVALID', async () => {
    const res = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        ticket: 'forged-ticket-value',
        displayName: '김의사',
        clinicName: '서울한의원',
        licenseNumber: 'LIC-0042',
        termsAccepted: true,
      })
      .expect(401);
    expect(res.body.code).toBe('AUTH_OAUTH_TICKET_INVALID');
  });

  // ── 세션 수명주기 (§4.3) ────────────────────────────────

  it('만료된 access 토큰 → 401 AUTH_TOKEN_EXPIRED', async () => {
    const expired = await app
      .get(JwtService)
      .signAsync({ sub: 'x', clinicId: 'y', sid: 'z' }, { expiresIn: -10 });
    const res = await request(server())
      .get('/api/v1/auth/me')
      .set('Cookie', `access_token=${expired}`)
      .expect(401);
    expect(res.body.code).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('refresh rotation: 재발급 성공 후 구 토큰 재사용 → family 전체 폐기 + 알림 (§4.3)', async () => {
    const { ticket } = await socialCallback(app, {
      email: 'rotate@clinic.kr',
      providerId: 'google-7007',
    });
    const signup = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        ticket,
        displayName: '김의사',
        clinicName: '서울한의원',
        licenseNumber: 'LIC-0042',
        termsAccepted: true,
      })
      .expect(201);
    const r1 = cookiesOf(signup).refresh_token;

    // 1) 정상 rotation → 새 쿠키 발급
    const refreshed = await request(server())
      .post('/api/v1/auth/refresh')
      .set(CSRF)
      .set('Cookie', `refresh_token=${r1.value}`)
      .expect(200);
    const r2 = cookiesOf(refreshed).refresh_token;
    expect(r2.value).not.toBe(r1.value);

    // 2) 구 토큰(r1) 재사용 → 탈취 간주
    const reused = await request(server())
      .post('/api/v1/auth/refresh')
      .set(CSRF)
      .set('Cookie', `refresh_token=${r1.value}`)
      .expect(401);
    expect(reused.body.code).toBe('AUTH_REFRESH_REUSED');
    expect(alertSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'AUTH_REFRESH_REUSED' }),
    );

    // 3) family 전체가 폐기되어 최신 토큰(r2)도 무효
    const revoked = await request(server())
      .post('/api/v1/auth/refresh')
      .set(CSRF)
      .set('Cookie', `refresh_token=${r2.value}`)
      .expect(401);
    expect(revoked.body.code).toBe('AUTH_REFRESH_REUSED');

    // 4) 같은 family의 최신 access 토큰도 denylist로 즉시 차단
    const a2 = cookiesOf(refreshed).access_token;
    await request(server())
      .get('/api/v1/auth/me')
      .set('Cookie', `access_token=${a2.value}`)
      .expect(401);
  });

  it('logout: TTL이 남은 access 토큰도 즉시 무효화된다 (denylist §4.3)', async () => {
    const { cookie } = await socialSignUp(app, {
      email: 'deny@clinic.kr',
      providerId: 'google-8008',
    });

    // 로그아웃 전: 정상 인증
    await request(server()).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);

    await request(server())
      .post('/api/v1/auth/logout')
      .set(CSRF)
      .set('Cookie', cookie)
      .expect(200);

    // 로그아웃 후: 같은 토큰(만료 전)이 즉시 거부
    const denied = await request(server())
      .get('/api/v1/auth/me')
      .set('Cookie', cookie)
      .expect(401);
    expect(denied.body.code).toBe('UNAUTHORIZED');
  });

  it('logout: family 폐기 + 만료 쿠키, 이후 refresh 불가', async () => {
    const { ticket } = await socialCallback(app, {
      email: 'logout@clinic.kr',
      providerId: 'google-9009',
    });
    const signup = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        ticket,
        displayName: '김의사',
        clinicName: '서울한의원',
        licenseNumber: 'LIC-0042',
        termsAccepted: true,
      })
      .expect(201);
    const { access_token: access, refresh_token: refresh } = cookiesOf(signup);

    const logout = await request(server())
      .post('/api/v1/auth/logout')
      .set(CSRF)
      .set('Cookie', [`access_token=${access.value}`, `refresh_token=${refresh.value}`])
      .expect(200);

    const expired = cookiesOf(logout);
    expect(expired.access_token.raw).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect(expired.refresh_token.raw).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);

    await request(server())
      .post('/api/v1/auth/refresh')
      .set(CSRF)
      .set('Cookie', `refresh_token=${refresh.value}`)
      .expect(401);
  });
});
