import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request, { Response as SupertestResponse } from 'supertest';
import { AppModule } from '../src/app.module';
import { RealTimeAlertSender } from '../src/global/observability/real-time-alert.sender';
import { AesGcmUtil } from '../src/global/security/crypto/aes-gcm.util';

const CSRF = { 'X-CSRF-Protection': '1' };

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

function signUpBody(email: string) {
  return {
    email,
    password: 'password-1234',
    displayName: '김의사',
    clinicName: '서울한의원',
    licenseNumber: 'LIC-0042',
    termsAccepted: true,
  };
}

describe('Auth (Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  const alertSender = { send: jest.fn() };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RealTimeAlertSender)
      .useValue(alertSender)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  beforeEach(() => {
    alertSender.send.mockClear();
  });

  const server = () => app.getHttpServer();

  it('signup: 201 CREATED + HttpOnly 쿠키 발급 + PENDING 상태', async () => {
    const res = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send(signUpBody('signup@clinic.kr'))
      .expect(201);

    expect(res.body.code).toBe('CREATED');
    expect(res.body.data.clinician).toMatchObject({
      email: 'signup@clinic.kr',
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
    await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send(signUpBody('license@clinic.kr'))
      .expect(201);

    const { rows } = await pool.query(
      "SELECT license_number_encrypted FROM clinicians WHERE email = 'license@clinic.kr'",
    );
    const stored: string = rows[0].license_number_encrypted;
    expect(stored).not.toContain('LIC-0042');
    expect(stored.startsWith('v1.')).toBe(true);
    expect(app.get(AesGcmUtil).decrypt(stored)).toBe('LIC-0042');
  });

  it('signup 중복 이메일 → 409 AUTH_EMAIL_ALREADY_USED', async () => {
    await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send(signUpBody('dup@clinic.kr'))
      .expect(201);
    const res = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send(signUpBody('dup@clinic.kr'))
      .expect(409);
    expect(res.body.code).toBe('AUTH_EMAIL_ALREADY_USED');
  });

  it('login 실패(비밀번호 불일치·미존재 이메일 동일 응답) → 401 AUTH_INVALID_CREDENTIALS', async () => {
    await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send(signUpBody('login-fail@clinic.kr'))
      .expect(201);

    const wrongPw = await request(server())
      .post('/api/v1/auth/login')
      .set(CSRF)
      .send({ email: 'login-fail@clinic.kr', password: 'wrong-password' })
      .expect(401);
    expect(wrongPw.body.code).toBe('AUTH_INVALID_CREDENTIALS');

    const noUser = await request(server())
      .post('/api/v1/auth/login')
      .set(CSRF)
      .send({ email: 'ghost@clinic.kr', password: 'password-1234' })
      .expect(401);
    expect(noUser.body.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('login → me: access 쿠키로 세션 복구', async () => {
    await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send(signUpBody('me@clinic.kr'))
      .expect(201);
    const login = await request(server())
      .post('/api/v1/auth/login')
      .set(CSRF)
      .send({ email: 'me@clinic.kr', password: 'password-1234' })
      .expect(200);

    const access = cookiesOf(login).access_token;
    const me = await request(server())
      .get('/api/v1/auth/me')
      .set('Cookie', `access_token=${access.value}`)
      .expect(200);
    expect(me.body.data.email).toBe('me@clinic.kr');
  });

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
    const signup = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send(signUpBody('rotate@clinic.kr'))
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
  });

  it('logout: family 폐기 + 만료 쿠키, 이후 refresh 불가', async () => {
    const signup = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send(signUpBody('logout@clinic.kr'))
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

  it('email-availability: 가용 여부 + rate limit(10/min) 초과 시 429 RATE_LIMITED', async () => {
    const taken = await request(server())
      .get('/api/v1/auth/email-availability')
      .query({ email: 'dup@clinic.kr' })
      .expect(200);
    expect(taken.body.data.available).toBe(false);

    const free = await request(server())
      .get('/api/v1/auth/email-availability')
      .query({ email: 'free@clinic.kr' })
      .expect(200);
    expect(free.body.data.available).toBe(true);

    // 앞선 2회 포함 10회까지 허용 → 이후 429
    for (let i = 0; i < 8; i += 1) {
      await request(server())
        .get('/api/v1/auth/email-availability')
        .query({ email: `probe${i}@clinic.kr` })
        .expect(200);
    }
    const limited = await request(server())
      .get('/api/v1/auth/email-availability')
      .query({ email: 'probe-final@clinic.kr' })
      .expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });
});
