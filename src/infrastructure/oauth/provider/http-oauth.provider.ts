/**
 * Authorization Code Grant 공통 구현 (docs/specs/17).
 * google/kakao/naver는 프로토콜이 같고 엔드포인트·응답 형태만 다르므로 정의를 주입받는다.
 */
import { OAuthProfile, OAuthProvider, OAuthProviderError, OAuthProviderId } from '../oauth-provider.port';
import { OAuthProviderDefinition } from './oauth-provider.definition';

/** 사용자가 리다이렉트 앞에서 대기 중이므로 짧게 끊는다 — 실패는 로그인 페이지로 되돌린다. */
const TIMEOUT_MS = 5_000;

export interface OAuthCredentials {
  clientId: string;
  /** kakao는 콘솔 설정에 따라 비어 있을 수 있다 */
  clientSecret: string;
}

export class HttpOAuthProvider implements OAuthProvider {
  constructor(
    private readonly definition: OAuthProviderDefinition,
    private readonly credentials: OAuthCredentials,
  ) {}

  get id(): OAuthProviderId {
    return this.definition.id;
  }

  authorizationUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const url = new URL(this.definition.authorizationUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.credentials.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', this.definition.scope);
    url.searchParams.set('state', state);
    for (const [key, value] of Object.entries(this.definition.extraAuthorizationParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async fetchProfile({
    code,
    state,
    redirectUri,
  }: {
    code: string;
    state: string;
    redirectUri: string;
  }): Promise<OAuthProfile> {
    const accessToken = await this.exchangeCode(code, state, redirectUri);
    const raw = await this.requestUserInfo(accessToken);
    const profile = this.definition.toProfile(raw);

    // providerId가 없으면 계정을 식별할 수 없다 — 로그인도 가입도 성립하지 않는다
    if (!profile.providerId) {
      throw new OAuthProviderError(`${this.id}: 사용자 식별자(providerId)를 받지 못했습니다.`);
    }

    return {
      provider: this.id,
      providerId: profile.providerId,
      email: profile.email,
      displayName: profile.displayName,
    };
  }

  private async exchangeCode(code: string, state: string, redirectUri: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.credentials.clientId,
      redirect_uri: redirectUri,
      code,
    });
    if (this.credentials.clientSecret) body.set('client_secret', this.credentials.clientSecret);
    if (this.definition.sendStateOnTokenExchange) body.set('state', state);

    const payload = await this.postForm(this.definition.tokenUrl, body);
    const accessToken = payload.access_token;
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new OAuthProviderError(`${this.id}: 토큰 응답에 access_token이 없습니다.`);
    }
    return accessToken;
  }

  private async postForm(url: string, body: URLSearchParams): Promise<Record<string, unknown>> {
    const response = await this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    return this.readJson(response, '토큰 교환');
  }

  private async requestUserInfo(accessToken: string): Promise<Record<string, unknown>> {
    const response = await this.request(this.definition.userInfoUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return this.readJson(response, '프로필 조회');
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new OAuthProviderError(`${this.id}: 요청 실패 — ${String(error)}`);
    }
  }

  private async readJson(response: Response, step: string): Promise<Record<string, unknown>> {
    const text = await response.text().catch(() => '');

    // naver는 실패도 200 + error 필드로 응답하므로 상태코드만으로 판정하지 않는다
    if (!response.ok) {
      throw new OAuthProviderError(`${this.id}: ${step} 실패 (${response.status}) ${trim(text)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new OAuthProviderError(`${this.id}: ${step} 응답이 JSON이 아닙니다. ${trim(text)}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new OAuthProviderError(`${this.id}: ${step} 응답 형식이 올바르지 않습니다.`);
    }

    const payload = parsed as Record<string, unknown>;
    if (typeof payload.error === 'string' && payload.error !== '') {
      throw new OAuthProviderError(`${this.id}: ${step} 실패 — ${payload.error}`);
    }
    return payload;
  }
}

function trim(text: string): string {
  return text.slice(0, 200);
}
