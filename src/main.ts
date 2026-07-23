import { NestFactory } from '@nestjs/core';
import { ConfigType } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { appConfig } from './global/config/app.config';
import { buildOpenApiDocument } from './global/openapi/openapi-document.factory';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.enableShutdownHooks();

  SwaggerModule.setup('api/docs', app, buildOpenApiDocument(app));

  const config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  await app.listen(config.port);
}

void bootstrap();
