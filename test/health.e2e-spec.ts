// docs/specs/16 수용 기준 5~6 동결 테스트 — 구현 중 수정 금지
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('health', () => {
  let app: INestApplication;
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);

    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.REDIS_URL = redis.getConnectionUrl();

    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  it('GET /api/v1/health는 인증 없이 ok를 반환한다', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);

    expect(res.body).toMatchObject({ success: true });
    expect(res.body.data.status).toBe('ok');
  });

  it('GET /api/v1/health/ready는 인증 없이 ready와 의존성 상태를 반환한다', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);

    expect(res.body).toMatchObject({ success: true });
    expect(res.body.data.status).toBe('ready');
    expect(res.body.data.dependencies.database).toBe('up');
    expect(res.body.data.dependencies.redis).toBe('up');
  });
});
