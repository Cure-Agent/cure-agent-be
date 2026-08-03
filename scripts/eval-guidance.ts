/**
 * 참고안 구조화 측정 CLI (docs/specs/33 — 배포 전 채택 게이트).
 * 사용법: DATABASE_URL·OPENAI_API_KEY 설정 후 `pnpm eval:guidance [평가셋.json] [케이스수]`
 *
 * 로직은 domain/evaluation이 갖는다 — 이 파일은 eval-groundedness.ts와 같은 얇은 래퍼다.
 */
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { AppModule } from '../src/app.module';
import { loadEvalSet } from '../src/domain/evaluation/evalset.loader';
import { GuidanceEvalService } from '../src/domain/evaluation/guidance-eval.service';
import { renderGuidanceEvalReport } from '../src/domain/evaluation/guidance-eval.report';

const DEFAULT_EVALSET = 'test/fixtures/rag-eval/evalset.json';

async function main(): Promise<void> {
  const file = process.argv[2] ?? DEFAULT_EVALSET;
  const limit = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
  if (limit !== undefined && !Number.isInteger(limit)) {
    throw new Error(`케이스 수가 정수가 아닙니다: ${process.argv[3]}`);
  }
  const items = loadEvalSet(JSON.parse(readFileSync(file, 'utf8')));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  let failureCount = 0;
  try {
    const report = await app.get(GuidanceEvalService).evaluate(items, { limit });
    console.log(renderGuidanceEvalReport(report));
    failureCount = report.failures.length;
  } finally {
    await app.close();
  }

  // 생성 실패를 조용히 넘기면 남은 케이스만으로 계산된 폴백률이 낙관 오염된다
  if (failureCount > 0) {
    console.error(`생성 실패 ${failureCount}건 — 리포트의 「실패 케이스」 절 참조`);
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
