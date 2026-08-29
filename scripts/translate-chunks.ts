/**
 * 청크 번역 배치 CLI (docs/specs/42).
 * 사용법: DATABASE_URL·OPENAI_API_KEY 등 env 설정 후
 *   pnpm translate:chunks            # 데모 6주제 655청크 (기본)
 *   pnpm translate:chunks --all      # ACTIVE 전량 7,154청크
 *
 * 잡이 멱등이라 재실행이 안전하다 — 이미 최신 번역이 있는 청크는 건너뛴다(기준 18).
 * 로직은 domain/guideline이 갖는다 — 이 파일은 eval-rag.ts와 같은 얇은 래퍼다.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ChunkTranslatorService } from '../src/domain/guideline/service/chunk-translator.service';

async function main(): Promise<void> {
  const scope = process.argv.includes('--all') ? 'all' : 'demo';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const result = await app.get(ChunkTranslatorService).translatePending({
      scope,
      target: 'en',
    });
    console.log(
      `대상 ${result.targeted} · 번역 ${result.translated} · 건너뜀 ${result.skipped} (scope=${scope})`,
    );
  } finally {
    await app.close();
  }
}

// 실패는 비영 종료다 — 조용한 부분 실패는 번역 커버리지를 낙관 오염시킨다
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
