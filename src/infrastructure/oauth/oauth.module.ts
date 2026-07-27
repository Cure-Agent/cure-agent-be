import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { oauthConfig } from '../../global/config/oauth.config';
import { OAuthProviderRegistry } from './oauth-provider.registry';

@Module({
  imports: [ConfigModule.forFeature(oauthConfig)],
  providers: [OAuthProviderRegistry],
  exports: [OAuthProviderRegistry],
})
export class OAuthModule {}
