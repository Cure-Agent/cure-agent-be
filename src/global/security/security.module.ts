import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { authConfig } from '../config/auth.config';
import { AuthCookieFactory } from './auth-cookie.factory';
import { PasswordHasher } from './password-hasher';
import { TokenResolver } from './token-resolver';

@Global()
@Module({
  imports: [
    ConfigModule.forFeature(authConfig),
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule.forFeature(authConfig)],
      inject: [authConfig.KEY],
      useFactory: (config: ConfigType<typeof authConfig>) => ({
        secret: config.jwtSecret,
        signOptions: { expiresIn: config.accessTtlSec },
      }),
    }),
  ],
  providers: [AuthCookieFactory, TokenResolver, PasswordHasher],
  exports: [AuthCookieFactory, TokenResolver, PasswordHasher],
})
export class SecurityModule {}
