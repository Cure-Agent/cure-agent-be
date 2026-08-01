/**
 * groundedness 평가 CLI (docs/specs/30).
 * 사용법: DATABASE_URL·OPENAI_API_KEY 설정 후 `pnpm eval:groundedness [평가셋.json]`
 *
 * 검색 평가(eval-rag)와 분리한 이유: 실 LLM 없이는 무의미하고 문항당 비용·지연이 ~10배다.
 * 로직은 domain/evaluation이 갖는다 — 이 파일은 ingest-guidelines.ts와 같은 얇은 래퍼다.
 */
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { AppModule } from '../src/app.module';
import { loadEvalSet } from '../src/domain/evaluation/evalset.loader';
import { GroundednessEvalService } from '../src/domain/evaluation/groundedness-eval.service';
import { renderGroundednessReport } from '../src/domain/evaluation/groundedness.report';

const DEFAULT_EVALSET = 'test/fixtures/rag-eval/evalset.json';

async function main(): Promise<void> {
  const file = process.argv[2] ?? DEFAULT_EVALSET;
  const items = loadEvalSet(JSON.parse(readFileSync(file, 'utf8')));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  let failureCount = 0;
  try {
    const report = await app.get(GroundednessEvalService).evaluate(items);
    console.log(renderGroundednessReport(report));
    failureCount = report.failures.length;
  } finally {
    await app.close();
  }

  // 생성·채점 실패는 조용히 넘어가지 않는다 — 남은 문항만으로 계산된 지표는 낙관 오염이다
  // (docs/specs/27 라벨 부패와 같은 이유)
  if (failureCount > 0) {
    console.error(`생성·채점 실패 ${failureCount}건 — 리포트의 「실패 문항」 절 참조`);
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
