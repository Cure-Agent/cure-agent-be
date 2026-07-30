/**
 * docs/specs/24 수용 기준 10·13·14.
 *
 * 원본 마커 부재 자체가 아니라 커밋된 대상 아님 목록이 PARSE/SKIPPED의 근거인지,
 * 목록 사유가 로그에 남는지, 마커가 관측되면 목록보다 정상 파싱이 우선하는지 검증한다.
 */
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  RedisContainer,
  StartedRedisContainer,
} from '@testcontainers/redis';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  NOT_INGEST_TARGETS,
  type NotIngestTarget,
} from '../src/domain/guideline/service/not-ingest-targets';
import { PdfTextExtractor } from '../src/infrastructure/document/pdf-text.extractor';
import { EMBEDDING_PROVIDER } from '../src/infrastructure/embedding/embedding-provider.port';
import {
  GUIDELINE_SOURCE,
  type SourceListItem,
} from '../src/infrastructure/guideline-source/guideline-source.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { FailingEmbeddingProvider } from './fixtures/failing-embedding.provider';
import { FakeGuidelineSource } from './fixtures/fake-guideline-source';
import {
  parenthesizedCoordinatePages,
  pipelineNoMarkerPages,
} from './fixtures/nckm-ingest-target-samples';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { FakePdfExtractor } from './fixtures/fake-pdf-extractor';
import { socialSignUp, type TestSession } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const JOB_TIMEOUT_MS = 30_000;

type JobStatus =
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELLING'
  | 'CANCELLED'
  | 'INTERRUPTED'
  | 'FAILED';

interface JobDto {
  id: string;
  status: JobStatus;
  total: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

interface RunDto {
  externalId: string | null;
  status: 'RUNNING' | 'SUCCEEDED' | 'SKIPPED' | 'FAILED' | 'INTERRUPTED';
  phase: 'ACQUIRE' | 'PARSE' | 'EMBED' | 'INGEST';
  errorCode: string | null;
  error: string | null;
  guidelineVersionId: string | null;
  stages: Record<string, Record<string, unknown>>;
}

interface JobDetailDto extends JobDto {
  runs: RunDto[];
}

interface ParseStageDto extends Record<string, unknown> {
  pages: number;
  sections: number;
  chunks: number;
  ms: number;
}

const renderLogValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

describe('spec 24: 목록 기반 PARSE 단계 인제스트 대상 판정', () => {
  jest.setTimeout(180_000);

  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication | undefined;
  let admin: TestSession;

  const fakeSource = new FakeGuidelineSource();
  const fakePdfExtractor = new FakePdfExtractor();
  const failingEmbedding = new FailingEmbeddingProvider();

  const currentApp = (): INestApplication => {
    if (!app) throw new Error('Nest 애플리케이션이 기동되지 않았습니다.');
    return app;
  };

  const committedTarget = (externalId: string): NotIngestTarget => {
    const listed = NOT_INGEST_TARGETS.find(
      (target) => target.externalId === externalId,
    );
    if (!listed) {
      throw new Error(
        `수용 기준 fixture에 필요한 대상 아님 목록 항목 ${externalId}가 없습니다.`,
      );
    }
    return listed;
  };

  const sourceItem = (
    externalId: string,
    version = '2026-07',
  ): SourceListItem => ({
    externalId,
    title: `합성 테스트 지침 ${externalId}`,
    publisher: '가상별빛학회',
    releaseDate: version,
    sourceUrl: `https://example.test/guidelines/${externalId}`,
    fileName: `${externalId}.pdf`,
  });

  const addPdf = (
    externalId: string,
    pages: string[],
    version = '2026-07',
  ): void => {
    const marker = `DOC:${externalId}`;
    fakeSource.addDocument(sourceItem(externalId, version), {
      body: Buffer.from(`%PDF-1.7\n${marker}\nsynthetic fixture`),
      contentType: 'application/pdf',
    });
    fakePdfExtractor.setPagesFor(marker, pages);
  };

  const startJob = async (): Promise<JobDto> => {
    const response = await request(currentApp().getHttpServer())
      .post('/api/v1/admin/guideline-jobs')
      .set(CSRF)
      .set('Cookie', admin.cookie)
      .send({});

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      success: true,
      code: 'SUCCESS',
      data: {
        status: 'RUNNING',
        total: 0,
        processed: 0,
        succeeded: 0,
        skipped: 0,
        failed: 0,
      },
    });
    return response.body.data as JobDto;
  };

  const getJob = async (jobId: string): Promise<JobDetailDto> => {
    const response = await request(currentApp().getHttpServer())
      .get(`/api/v1/admin/guideline-jobs/${jobId}`)
      .set('Cookie', admin.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      code: 'SUCCESS',
    });
    return response.body.data as JobDetailDto;
  };

  const waitForJob = async (jobId: string): Promise<JobDetailDto> => {
    const terminalStatuses: JobStatus[] = [
      'COMPLETED',
      'CANCELLED',
      'INTERRUPTED',
      'FAILED',
    ];
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    let last: JobDetailDto | undefined;

    while (Date.now() < deadline) {
      last = await getJob(jobId);
      if (terminalStatuses.includes(last.status)) return last;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    throw new Error(
      `잡 ${jobId}가 ${JOB_TIMEOUT_MS}ms 안에 끝나지 않았습니다. ` +
        `마지막 상태=${last?.status ?? '조회 전'}`,
    );
  };

  const runFor = (
    completed: JobDetailDto,
    externalId: string,
  ): RunDto => {
    const run = completed.runs.find(
      (candidate) => candidate.externalId === externalId,
    );
    expect(run).toBeDefined();
    if (!run) {
      throw new Error(`pipeline_run을 찾지 못했습니다: ${externalId}`);
    }
    return run;
  };

  beforeAll(async () => {
    [postgresContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = postgresContainer.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    pool = new Pool({
      connectionString: postgresContainer.getConnectionUri(),
    });
    await migrate(drizzle(pool), {
      migrationsFolder: 'drizzle/migrations',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(GUIDELINE_SOURCE)
      .useValue(fakeSource)
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(failingEmbedding)
      .overrideProvider(PdfTextExtractor)
      .useValue(fakePdfExtractor)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.listen(0);

    admin = await socialSignUp(currentApp(), {
      email: 'guideline-ingest-target-list-admin@clinic.kr',
      providerId: 'guideline-ingest-target-list-admin',
    });
    await pool.query(`UPDATE clinicians SET role = 'ADMIN' WHERE id = $1`, [
      admin.clinicianId,
    ]);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        pipeline_runs,
        guideline_jobs,
        message_citations,
        generation_runs,
        answer_feedbacks,
        messages,
        conversations,
        evidence_chunks,
        guideline_sections,
        guideline_versions,
        guidelines,
        source_documents
      CASCADE
    `);
    fakeSource.reset();
    fakePdfExtractor.reset();
    failingEmbedding.reset();
  });

  afterAll(async () => {
    fakeSource.resumeDownloads();
    await app?.close();
    await pool?.end();
    await postgresContainer?.stop();
    await redisContainer?.stop();
  });

  it('기준 10a: 마커가 없고 대상 아님 목록에 있는 문서는 SKIPPED/PARSE로 종결한다', async () => {
    const listed = committedTarget('90');
    addPdf(listed.externalId, pipelineNoMarkerPages, listed.version);

    const created = await startJob();
    const completed = await waitForJob(created.id);
    const run = runFor(completed, listed.externalId);

    expect(run).toMatchObject({
      status: 'SKIPPED',
      phase: 'PARSE',
      errorCode: null,
      error: null,
    });
    expect(completed).toMatchObject({
      total: 1,
      processed: 1,
      succeeded: 0,
      skipped: 1,
      failed: 0,
    });
  });

  it('기준 10b: 마커가 없고 대상 아님 목록에도 없는 문서는 FAILED로 종결한다', async () => {
    // 파이프라인이 이미 "목록 밖이면 FAILED"만 선반영한 경우에도 빈 목록 스텁은 죽인다.
    expect(committedTarget('90').reason).toEqual(expect.stringMatching(/\S/));

    const externalId = 'synthetic-unlisted-no-marker';
    addPdf(externalId, pipelineNoMarkerPages);

    const created = await startJob();
    const completed = await waitForJob(created.id);
    const run = runFor(completed, externalId);

    expect(run).toMatchObject({
      status: 'FAILED',
      phase: 'PARSE',
    });
    expect(run.status).not.toBe('SKIPPED');
    expect(completed).toMatchObject({
      total: 1,
      processed: 1,
      skipped: 0,
      failed: 1,
    });
  });

  it('기준 10c: 목록 밖의 마커 없는 문서 실행에 파싱 실패 에러를 기록한다', async () => {
    expect(committedTarget('90').reason).toEqual(expect.stringMatching(/\S/));

    const externalId = 'synthetic-unlisted-parse-error';
    addPdf(externalId, pipelineNoMarkerPages);

    const created = await startJob();
    const completed = await waitForJob(created.id);
    const run = runFor(completed, externalId);

    expect(run).toMatchObject({
      status: 'FAILED',
      phase: 'PARSE',
      errorCode: 'GUIDELINE_PARSE_FAILED',
      error: expect.stringMatching(/\S/),
      guidelineVersionId: null,
    });
  });

  it('기준 13a: 목록에 따라 SKIPPED로 끝낼 때 커밋된 사유를 Logger에 남긴다', async () => {
    const listed = committedTarget('91');
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      addPdf(listed.externalId, pipelineNoMarkerPages, listed.version);

      const created = await startJob();
      const completed = await waitForJob(created.id);
      const run = runFor(completed, listed.externalId);

      expect(run).toMatchObject({
        status: 'SKIPPED',
        phase: 'PARSE',
      });

      const logged = [...logSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map(renderLogValue)
        .join('\n');
      expect(logged).toContain(listed.reason);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('기준 14a: 목록 항목과 일치해도 마커가 있는 문서는 SKIPPED하지 않고 정상 파싱한다', async () => {
    const listed = committedTarget('92');
    addPdf(
      listed.externalId,
      parenthesizedCoordinatePages,
      listed.version,
    );

    const created = await startJob();
    const completed = await waitForJob(created.id);
    const run = runFor(completed, listed.externalId);
    const parse = run.stages.parse as ParseStageDto | undefined;

    expect(run.status).not.toBe('SKIPPED');
    expect(['SUCCEEDED', 'FAILED']).toContain(run.status);
    expect(parse).toBeDefined();
    expect(parse?.pages).toBe(parenthesizedCoordinatePages.length);
    expect(parse?.chunks).toBeGreaterThan(0);
  });
});
