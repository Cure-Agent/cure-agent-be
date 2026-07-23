import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ApiExceptionFilter } from './global/common/exception/api-exception.filter';
import { buildGlobalValidationPipe } from './global/common/pipe/global-validation.pipe';
import { ApiResponseInterceptor } from './global/common/response/api-response.interceptor';
import { alertConfig } from './global/config/alert.config';
import { appConfig } from './global/config/app.config';
import { validateEnv } from './global/config/env.validation';
import { ContextModule } from './global/context/context.module';
import { ObservabilityModule } from './global/observability/observability.module';
import { cryptoConfig } from './global/security/crypto/crypto.config';
import { CryptoModule } from './global/security/crypto/crypto.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, alertConfig, cryptoConfig],
      validate: validateEnv,
    }),
    ContextModule,
    ObservabilityModule,
    CryptoModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_PIPE, useFactory: buildGlobalValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
