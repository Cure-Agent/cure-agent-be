import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { alertConfig } from '../config/alert.config';
import { IgnorableExceptionClassifier } from './ignorable-exception.classifier';
import { HttpMetricsMiddleware } from './metrics/http-metrics.middleware';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsService } from './metrics/metrics.service';
import { RealTimeAlertSender } from './real-time-alert.sender';

@Global()
@Module({
  imports: [ConfigModule.forFeature(alertConfig)],
  controllers: [MetricsController],
  providers: [
    RealTimeAlertSender,
    IgnorableExceptionClassifier,
    MetricsService,
    HttpMetricsMiddleware,
  ],
  exports: [RealTimeAlertSender, IgnorableExceptionClassifier, MetricsService, HttpMetricsMiddleware],
})
// NOTE: HttpMetricsMiddleware는 NestModule.configure()가 아니라 main.ts의 app.use로 붙인다 —
// MiddlewareConsumer 경로는 setGlobalPrefix('api/v1') 아래로 한정되어, prefix 밖 요청
// (스캐너의 /wp-login.php, Swagger의 /api/docs)이 통째로 계측에서 빠지기 때문이다.
export class ObservabilityModule {}
