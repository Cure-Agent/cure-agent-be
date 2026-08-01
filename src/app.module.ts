import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './domain/auth/auth.module';
import { ClinicianModule } from './domain/clinician/clinician.module';
import { ConversationModule } from './domain/conversation/conversation.module';
import { ClinicalGuidanceModule } from './domain/clinical-guidance/clinical-guidance.module';
import { EvaluationModule } from './domain/evaluation/evaluation.module';
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
import { oauthConfig } from './global/config/oauth.config';
import { guidelineScanConfig } from './global/config/guideline-scan.config';
import { redisConfig } from './global/config/redis.config';
import { retrievalConfig } from './global/config/retrieval.config';
import { SchedulerModule } from './infrastructure/scheduler/scheduler.module';
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
      load: [
        appConfig,
        alertConfig,
        cryptoConfig,
        databaseConfig,
        authConfig,
        oauthConfig,
        redisConfig,
        guidelineScanConfig,
        retrievalConfig,
      ],
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    // 크론 런타임 (docs/specs/26). 잡 등록 자체는 SchedulerModule이 설정을 보고 결정한다
    ScheduleModule.forRoot(),
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
    ClinicalGuidanceModule,
    // 개정 감지 크론 트리거 (docs/specs/26) — GuidelineModule 뒤에 온다
    SchedulerModule,
    // RAG 평가 (docs/specs/27) — 컨트롤러 없음. scripts/eval-rag.ts와 e2e가 소비한다
    EvaluationModule,
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
