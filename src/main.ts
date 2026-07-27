import { NestFactory } from '@nestjs/core';
import { ConfigType } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { appConfig } from './global/config/app.config';
import { HttpMetricsMiddleware } from './global/observability/metrics/http-metrics.middleware';
import { buildOpenApiDocument } from './global/openapi/openapi-document.factory';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');

  // 글로벌 prefix 밖(스캐너 경로·Swagger)까지 포함해 전 요청을 계측한다.
  // 가장 앞단에 둬야 필터·가드 처리 시간까지 응답 지연에 포함된다.
  const httpMetrics = app.get(HttpMetricsMiddleware);
  app.use(httpMetrics.use.bind(httpMetrics));

  app.use(cookieParser());
  app.enableShutdownHooks();

  SwaggerModule.setup('api/docs', app, buildOpenApiDocument(app));

  const config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  await app.listen(config.port);
}

void bootstrap();
