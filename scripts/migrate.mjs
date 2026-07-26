// 프로덕션 마이그레이션 실행기 — deploy.sh가 컨테이너에서 실행한다 (docs: 배포 계획 v2).
// drizzle-kit은 devDependency라 프로덕션 이미지에 없다(pnpm prune --prod) —
// 런타임 의존성인 drizzle-orm 내장 migrator로 drizzle/migrations/를 적용한다.
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] DATABASE_URL is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle(pool), { migrationsFolder: './drizzle/migrations' });
  console.log('[migrate] done');
} catch (err) {
  console.error('[migrate] failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
