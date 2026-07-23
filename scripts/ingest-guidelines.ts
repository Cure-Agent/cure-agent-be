/**
 * 지침 인제스트 CLI (docs/specs/05).
 * 사용법: DATABASE_URL 등 env 설정 후 `pnpm ingest <입력.json>`
 * 입력 형식은 src/domain/guideline/service/guideline-ingest.input.ts 참조.
 */
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { AppModule } from '../src/app.module';
import { GuidelineIngestInput } from '../src/domain/guideline/service/guideline-ingest.input';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('사용법: pnpm ingest <입력.json>  (.env의 DATABASE_URL 등 필요)');
    process.exit(1);
  }

  const input = JSON.parse(readFileSync(file, 'utf8')) as GuidelineIngestInput;
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const result = await app.get(GuidelineIngestService).ingest(input);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

void main();
