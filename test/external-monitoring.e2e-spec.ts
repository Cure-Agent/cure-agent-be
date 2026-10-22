// docs/specs/58 수용 기준 1~6 동결 테스트 — 구현 중 수정 금지
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import request, { Response as SupertestResponse } from 'supertest';
import { parse } from 'yaml';
import { AppModule } from '../src/app.module';
import { RealTimeAlertSender } from '../src/global/observability/real-time-alert.sender';
import { bootstrapApp } from './fixtures/app-bootstrap';

const REPOSITORY_ROOT = join(__dirname, '..');
const READY_KEYWORD = '"status":"ready"';

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}이(가) 객체가 아니다`);
  }
  return value as Record<string, unknown>;
}

function normalizeEnvironment(value: unknown): Map<string, unknown> {
  if (value === undefined || value === null) {
    return new Map();
  }
  if (Array.isArray(value)) {
    const environment = new Map<string, unknown>();
    for (const item of value) {
      if (typeof item !== 'string') {
        throw new Error('environment 항목이 문자열이 아니다');
      }
      const separator = item.indexOf('=');
      environment.set(
        separator < 0 ? item : item.slice(0, separator),
        separator < 0 ? undefined : item.slice(separator + 1),
      );
    }
    return environment;
  }
  return new Map(Object.entries(requireRecord(value, 'environment')));
}

function readDeployJob(): Record<string, unknown> {
  const document: unknown = parse(
    readFileSync(join(REPOSITORY_ROOT, '.github', 'workflows', 'cd-gcp-us.yml'), 'utf8'),
  );
  const jobs = requireRecord(requireRecord(document, 'workflow').jobs, 'jobs');
  return requireRecord(jobs['deploy-us'], 'jobs.deploy-us');
}

describe('외부 모니터링 — 운영 알림 통로 (§58 기준 4~6)', () => {
  it('기준 4: 운영 app 환경에 ALERT_WEBHOOK_URLS 키가 있다', () => {
    const document: unknown = parse(
      readFileSync(join(REPOSITORY_ROOT, 'docker', 'gcp-us', 'compose.yml'), 'utf8'),
    );
    const services = requireRecord(requireRecord(document, 'compose').services, 'services');
    const app = requireRecord(services.app, 'services.app');

    expect(normalizeEnvironment(app.environment).has('ALERT_WEBHOOK_URLS')).toBe(true);
  });

  it('기준 5: deploy-us 잡이 ALERT_WEBHOOK_URLS 시크릿을 받는다', () => {
    const environment = requireRecord(readDeployJob().env, 'deploy-us.env');

    expect(environment.ALERT_WEBHOOK_URLS).toBe('${{ secrets.ALERT_WEBHOOK_URLS }}');
  });

  it('기준 6: SSH 배포 단계가 ALERT_WEBHOOK_URLS를 원격 셸로 전달한다', () => {
    const steps = readDeployJob().steps;
    if (!Array.isArray(steps)) {
      throw new Error('deploy-us.steps가 목록이 아니다');
    }
    const sshSteps = steps
      .map((step: unknown) => requireRecord(step, 'step'))
      .filter((step) => typeof step.uses === 'string' && step.uses.startsWith('appleboy/ssh-action'));

    expect(sshSteps.length).toBeGreaterThan(0);
    for (const step of sshSteps) {
      const envs = requireRecord(step.with, 'SSH with').envs;
      expect(typeof envs).toBe('string');
      if (typeof envs !== 'string') {
        throw new Error('SSH with.envs가 문자열이 아니다');
      }
      expect(envs.split(',').map((name) => name.trim())).toContain('ALERT_WEBHOOK_URLS');
    }
  });
});

describe('외부 모니터링 — readiness 원문 (Testcontainers, §58 기준 1~3)', () => {
  let app: INestApplication;
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let redisStopped = false;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.REDIS_URL = redis.getConnectionUrl();

    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RealTimeAlertSender)
      .useValue({ send: jest.fn() })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      try {
        await pool?.end();
      } finally {
        await Promise.all([
          postgres?.stop(),
          redisStopped ? Promise.resolve() : redis?.stop(),
        ]);
      }
    }
  }, 60_000);

  it('기준 1: 200 응답 원문에 공백 없는 ready 키워드가 있다', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.text).toContain(READY_KEYWORD);
  });

  // Redis 중단은 양성 대조 뒤 마지막 테스트에서만 수행한다.
  it('기준 2·3: Redis 중단 후 503이며 그 응답 원문에 ready 키워드가 없다', async () => {
    await redis.stop();
    redisStopped = true;

    const deadline = Date.now() + 30_000;
    let res: SupertestResponse | undefined;
    while (Date.now() < deadline) {
      res = await request(app.getHttpServer())
        .get('/api/v1/health/ready')
        .timeout({ deadline: Math.max(1, deadline - Date.now()) });
      if (res.status === 503) {
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(200, remaining)));
      }
    }

    // 503을 먼저 확인해 다른 상태나 빈 응답의 키워드 부재가 통과하지 못하게 한다.
    expect(res?.status).toBe(503);
    expect(res!.text).not.toContain(READY_KEYWORD);
  }, 60_000);
});
