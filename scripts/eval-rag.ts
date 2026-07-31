/**
 * RAG 기준선 측정 CLI (docs/specs/27).
 * 사용법: DATABASE_URL 등 env 설정 후 `pnpm eval:rag [평가셋.json]`
 * 기본 평가셋은 test/fixtures/rag-eval/evalset.json이다.
 *
 * 로직은 domain/evaluation이 갖는다 — 이 파일은 ingest-guidelines.ts와 같은 얇은 래퍼다.
 */
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { AppModule } from '../src/app.module';
import { loadEvalSet } from '../src/domain/evaluation/evalset.loader';
import { renderEvalReport } from '../src/domain/evaluation/rag-eval.report';
import { RagEvalService } from '../src/domain/evaluation/rag-eval.service';

const DEFAULT_EVALSET = 'test/fixtures/rag-eval/evalset.json';

async function main(): Promise<void> {
  const file = process.argv[2] ?? DEFAULT_EVALSET;
  const items = loadEvalSet(JSON.parse(readFileSync(file, 'utf8')));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const report = await app.get(RagEvalService).evaluate(items);
    console.log(renderEvalReport(report));
  } finally {
    await app.close();
  }
}

// 라벨 해석 실패·스키마 위반은 비영 종료다 — 조용한 스킵은 기준선을 낙관 오염시킨다 (기준 3·4)
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
