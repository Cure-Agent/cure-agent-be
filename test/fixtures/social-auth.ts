import { INestApplication } from '@nestjs/common';
import request, { Response as SupertestResponse } from 'supertest';
import { OAuthProviderId } from '../../src/infrastructure/oauth/oauth-provider.port';
import { FakeProfile, encodeFakeCode } from './fake-oauth';

const CSRF = { 'X-CSRF-Protection': '1' };

/** Set-Cookie 헤더에서 이름 → 원본 문자열 맵 추출 */
export function setCookies(res: SupertestResponse): Record<string, string> {
  const headers = (res.headers['set-cookie'] ?? []) as unknown as string[];
  return Object.fromEntries(
    headers.map((raw) => [raw.slice(0, raw.indexOf('=')), raw] as const),
  );
}

/** `access_token=...` — 보호 라우트 호출 시 Cookie 헤더에 넣는 값 */
export function accessCookieOf(res: SupertestResponse): string {
  const raw = setCookies(res).access_token;
  if (!raw) throw new Error('응답에 access_token 쿠키가 없습니다.');
  return raw.split(';')[0];
}

export interface SocialCallbackResult {
  response: SupertestResponse;
  /** 302 Location */
  location: string;
  /** 신규 회원일 때만 채워진다 */
  ticket: string | null;
}

export interface SocialIdentity {
  email: string | null;
  /** 미지정이면 이메일에서 파생한다 — 계정 하나만 필요한 스펙의 잡음을 줄인다 */
  providerId?: string;
  displayName?: string | null;
  provider?: OAuthProviderId;
}

export interface OnboardingInput {
  displayName?: string;
  clinicName?: string;
  licenseNumber?: string;
}

export interface TestSession {
  /** Cookie 헤더 값 (`access_token=...`) */
  cookie: string;
  clinicianId: string;
  clinicId: string;
}

/**
 * 소셜 로그인 시작 → 콜백까지 실제 HTTP 경로로 진행한다 (docs/specs/17).
 * state 쿠키 왕복까지 그대로 태우므로 인증 플로우가 매 스펙에서 검증된다.
 */
export async function socialCallback(
  app: INestApplication,
  identity: SocialIdentity,
): Promise<SocialCallbackResult> {
  const provider = (identity.provider ?? 'GOOGLE').toLowerCase();
  const server = app.getHttpServer();

  /**
   * 진단 계측 (issue #250) — 이 요청이 e2e flake의 유일한 잔여 시그니처다.
   * `@Public()` 라우트라 핸들러는 302 또는 리다이렉트만 반환하는데 간헐적으로 401이 온다.
   * **그 401은 이 핸들러에서 나올 수 없으므로** 어느 앱·어느 라우트가 답했는지를 봐야 한다:
   * 응답 봉투의 code·traceId와 요청이 향한 포트를 실패 메시지에 실어 로그와 대조한다.
   */
  const started = await request(server).get(`/api/v1/auth/oauth/${provider}`);
  if (started.status !== 302) {
    const address = server.address() as { port?: number } | string | null;
    const port = typeof address === 'object' && address ? address.port : address;
    throw new Error(
      `[#250] OAuth start가 302가 아니다 — status=${started.status} port=${String(port)} ` +
        `body=${JSON.stringify(started.body)} headers=${JSON.stringify(started.headers)}`,
    );
  }
  const stateCookie = setCookies(started).oauth_state.split(';')[0];
  const state = stateCookie.slice('oauth_state='.length);

  const profile: FakeProfile = {
    providerId: identity.providerId ?? `fake-${identity.email ?? 'anonymous'}`,
    email: identity.email,
    displayName: identity.displayName ?? null,
  };
  const response = await request(server)
    .get(`/api/v1/auth/oauth/${provider}/callback`)
    .query({ code: encodeFakeCode(profile), state })
    .set('Cookie', stateCookie)
    .expect(302);

  const location: string = response.headers.location;
  return { response, location, ticket: new URL(location).searchParams.get('ticket') };
}

/**
 * 이미 가입된 소셜 계정으로 재로그인해 access 쿠키만 얻는다.
 * 같은 DB에 다른 app 인스턴스로 붙는 스펙(프로바이더 오버라이드 등)에서 쓴다.
 */
export async function socialLogin(
  app: INestApplication,
  identity: SocialIdentity,
): Promise<string> {
  const { response, ticket } = await socialCallback(app, identity);
  if (ticket) throw new Error(`미가입 계정입니다: ${identity.email}`);
  return accessCookieOf(response);
}

/** 소셜 콜백 → 온보딩 완료까지. 보호 라우트를 쓰는 스펙의 표준 계정 준비 경로다. */
export async function socialSignUp(
  app: INestApplication,
  identity: SocialIdentity & OnboardingInput,
): Promise<TestSession> {
  const { ticket } = await socialCallback(app, identity);
  if (!ticket) throw new Error(`신규 가입 티켓을 받지 못했습니다. (${identity.email})`);

  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/signup')
    .set(CSRF)
    .send({
      ticket,
      displayName: identity.displayName ?? '김의사',
      clinicName: identity.clinicName ?? '서울한의원',
      licenseNumber: identity.licenseNumber ?? 'LIC-0042',
      termsAccepted: true,
    })
    .expect(201);

  return {
    cookie: accessCookieOf(res),
    clinicianId: res.body.data.clinician.id as string,
    clinicId: res.body.data.clinician.clinic.id as string,
  };
}
