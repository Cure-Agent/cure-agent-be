import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { oauthConfig } from '../../global/config/oauth.config';
import { OAuthProvider, OAuthProviderId } from './oauth-provider.port';
import {
  GOOGLE_DEFINITION,
  KAKAO_DEFINITION,
  NAVER_DEFINITION,
  OAuthProviderDefinition,
} from './provider/oauth-provider.definition';
import { HttpOAuthProvider, OAuthCredentials } from './provider/http-oauth.provider';

/**
 * 활성 소셜 프로바이더 레지스트리 (docs/specs/17).
 * client id가 설정된 제공자만 등록한다 — 미설정 제공자는 FE 버튼에도 나타나지 않는다.
 */
@Injectable()
export class OAuthProviderRegistry {
  private readonly logger = new Logger(OAuthProviderRegistry.name);
  private readonly providers = new Map<OAuthProviderId, OAuthProvider>();

  constructor(
    @Inject(oauthConfig.KEY)
    config: ConfigType<typeof oauthConfig>,
  ) {
    this.register(GOOGLE_DEFINITION, config.google);
    this.register(KAKAO_DEFINITION, config.kakao);
    this.register(NAVER_DEFINITION, config.naver);

    if (this.providers.size === 0) {
      this.logger.warn(
        '등록된 소셜 로그인 제공자가 없습니다. {GOOGLE|KAKAO|NAVER}_CLIENT_ID를 설정하세요.',
      );
    }
  }

  /** 미등록·미지원 제공자는 null — 호출측이 에러코드로 변환한다. */
  find(id: string): OAuthProvider | null {
    return this.providers.get(id.toUpperCase() as OAuthProviderId) ?? null;
  }

  enabledIds(): OAuthProviderId[] {
    return [...this.providers.keys()];
  }

  private register(definition: OAuthProviderDefinition, credentials: OAuthCredentials): void {
    if (!credentials.clientId) return;
    this.providers.set(definition.id, new HttpOAuthProvider(definition, credentials));
  }
}
