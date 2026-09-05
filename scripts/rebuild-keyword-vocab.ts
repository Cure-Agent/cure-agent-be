/**
 * 키워드 어휘 전량 재생성 CLI (docs/specs/45).
 * 사용법: DATABASE_URL 설정 후 `pnpm rebuild:keyword-vocab`
 *
 * 초기 백필·복구 수단이다. 마이그레이션 트랜잭션에 넣지 않는 이유는 prod ~70s로 길고,
 * 복구·재빌드에도 같은 수단이 필요하기 때문이다. 레포 관행대로 로컬 체크아웃에서 터널로 돈다.
 *
 * **멱등이며 `keyword_chunk_index`의 ix는 보존한다** — 재배정하면 살아 있는 앱 프로세스의
 * 인메모리 포스팅이 남의 청크를 가리킨다(캐시 무효화가 프로세스 경계를 못 넘는다).
 *
 * 로직은 domain/guideline이 갖는다 — 이 파일은 translate-chunks.ts와 같은 얇은 래퍼다.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { KeywordVocabularyService } from '../src/domain/guideline/service/keyword-vocabulary.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const result = await app.get(KeywordVocabularyService).rebuildAll();
    console.log(
      `어휘 항 ${result.terms} · 포스팅 ${result.postings} · 청크 ${result.chunks}`,
    );
  } finally {
    await app.close();
  }
}

// 실패는 비영 종료다 — 조용한 부분 실패는 어휘를 stale로 남겨 검색 결과를 조용히 틀리게 한다
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
