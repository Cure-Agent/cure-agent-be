import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './domain/auth/auth.module';
import { ClinicianModule } from './domain/clinician/clinician.module';
import { ConversationModule } from './domain/conversation/conversation.module';
import { PatientModule } from './domain/patient/patient.module';
import { GuidelineModule } from './domain/guideline/guideline.module';
import { LlmModule } from './infrastructure/llm/llm.module';
import { ApiExceptionFilter } from './global/common/exception/api-exception.filter';
import { buildGlobalValidationPipe } from './global/common/pipe/global-validation.pipe';
import { ApiResponseInterceptor } from './global/common/response/api-response.interceptor';
import { alertConfig } from './global/config/alert.config';
import { appConfig } from './global/config/app.config';
import { authConfig } from './global/config/auth.config';
import { databaseConfig } from './global/config/database.config';
import { redisConfig } from './global/config/redis.config';
import { validateEnv } from './global/config/env.validation';
import { ContextModule } from './global/context/context.module';
import { DatabaseModule } from './global/database/database.module';
import { ObservabilityModule } from './global/observability/observability.module';
import { RedisModule } from './global/redis/redis.module';
import { cryptoConfig } from './global/security/crypto/crypto.config';
import { CryptoModule } from './global/security/crypto/crypto.module';
import { CsrfGuard } from './global/security/csrf.guard';
import { JwtAuthGuard } from './global/security/jwt-auth.guard';
import { SecurityModule } from './global/security/security.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, alertConfig, cryptoConfig, databaseConfig, authConfig, redisConfig],
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    ContextModule,
    ObservabilityModule,
    CryptoModule,
    DatabaseModule,
    RedisModule,
    SecurityModule,
    HealthModule,
    ClinicianModule,
    AuthModule,
    GuidelineModule,
    LlmModule,
    ConversationModule,
    PatientModule,
  ],
  providers: [
    { provide: APP_PIPE, useFactory: buildGlobalValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    // 등록 순서 = 실행 순서: CSRF → JWT
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
