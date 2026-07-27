import {
  OAUTH_PROVIDER_IDS,
  OAuthProfile,
  OAuthProvider,
  OAuthProviderId,
} from '../../src/infrastructure/oauth/oauth-provider.port';

/**
 * e2e용 가짜 소셜 제공자 (docs/specs/17).
 * 프로필을 code에 실어 보내므로 외부 호출 없이 콜백 분기를 실제 코드 경로 그대로 태울 수 있다.
 * 테스트 간 공유 상태가 없어 병렬·순서 의존이 생기지 않는다.
 */
export type FakeProfile = Omit<OAuthProfile, 'provider'>;

export function encodeFakeCode(profile: FakeProfile): string {
  return Buffer.from(JSON.stringify(profile)).toString('base64url');
}

class FakeOAuthProvider implements OAuthProvider {
  constructor(readonly id: OAuthProviderId) {}

  authorizationUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const url = new URL(`https://fake-oauth.test/${this.id.toLowerCase()}/authorize`);
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', redirectUri);
    return url.toString();
  }

  fetchProfile({ code }: { code: string }): Promise<OAuthProfile> {
    const decoded = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) as FakeProfile;
    return Promise.resolve({ provider: this.id, ...decoded });
  }
}

/** OAuthProviderRegistry 대체제 — 세 제공자 전부 활성으로 취급한다. */
export class FakeOAuthProviderRegistry {
  private readonly providers = new Map<OAuthProviderId, OAuthProvider>(
    OAUTH_PROVIDER_IDS.map((id) => [id, new FakeOAuthProvider(id)] as const),
  );

  find(id: string): OAuthProvider | null {
    return this.providers.get(id.toUpperCase() as OAuthProviderId) ?? null;
  }

  enabledIds(): OAuthProviderId[] {
    return [...this.providers.keys()];
  }
}
