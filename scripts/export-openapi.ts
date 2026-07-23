/**
 * OpenAPI 계약 export (architecture.md §1).
 * 실행: pnpm openapi:export → openapi/cure-agent.v1.json 갱신 후 커밋.
 * test/contract가 "커밋된 스펙 = 코드 재생성본"을 검증하므로,
 * DTO·컨트롤러를 바꾸면 반드시 이 스크립트를 다시 실행해야 한다.
 */

// 계약 생성에는 실제 인프라가 필요 없다 — 부팅 검증용 더미 env (미설정 시에만)
process.env.CRYPTO_ENC_KEYS ??= JSON.stringify({
  v1: Buffer.alloc(32, 1).toString('base64'),
});
process.env.CRYPTO_ENC_ACTIVE_VERSION ??= 'v1';
process.env.CRYPTO_HMAC_INDEX_KEY ??= Buffer.alloc(32, 3).toString('base64');
process.env.DATABASE_URL ??= 'postgres://placeholder:placeholder@localhost:5/placeholder';
process.env.REDIS_URL ??= 'redis://localhost:6390';
process.env.AUTH_JWT_SECRET ??= 'export-only-jwt-secret-export-only-jwt-secret';

import { NestFactory } from '@nestjs/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/global/openapi/openapi-document.factory';

const OUTPUT_PATH = join(__dirname, '..', 'openapi', 'cure-agent.v1.json');

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1');

  const document = buildOpenApiDocument(app);
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  await app.close();
  console.log(`openapi/cure-agent.v1.json export 완료 (paths: ${Object.keys(document.paths).length}개)`);
}

void main();
