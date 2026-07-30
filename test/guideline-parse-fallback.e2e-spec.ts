/**
 * 이슈 #144: 대상 아님 목록의 PARSE 실패 fallback 수용 기준.
 *
 * 실제 지침 원문을 옮기지 않은 합성 페이지로 다음 경계를 검증한다.
 * 원본에서 권고 마커가 관측됐지만 페이지 판정 뒤 파싱할 블록이 남지 않은 문서는,
 * 네 축이 모두 일치하는 대상 아님 목록 항목이 있을 때만 PARSE/SKIPPED로 종결해야 한다.
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
import { createHash } from 'node:crypto';
import { GuidelineListProvider } from '../src/domain/guideline/service/guideline-list.provider';
import { type NotIngestTarget } from '../src/domain/guideline/service/not-ingest-targets';
import { PdfTextExtractor } from '../src/infrastructure/document/pdf-text.extractor';
import { EMBEDDING_PROVIDER } from '../src/infrastructure/embedding/embedding-provider.port';
import {
  GUIDELINE_SOURCE,
  type SourceListItem,
} from '../src/infrastructure/guideline-source/guideline-source.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { FailingEmbeddingProvider } from './fixtures/failing-embedding.provider';
import { FakeGuidelineSource } from './fixtures/fake-guideline-source';
import { parenthesizedCoordinatePages } from './fixtures/nckm-ingest-target-samples';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { FakePdfExtractor } from './fixtures/fake-pdf-extractor';
import { socialSignUp, type TestSession } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const JOB_TIMEOUT_MS = 30_000;
const SYNTHETIC_VERSION = '2026-07';

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

/**
 * 두 번째 페이지에만 권고 마커와 등급 모양이 있다.
 *
 * 첫 페이지는 합성 인쇄 번호를 가져 장 판정 대상이지만 권고 블록이 없다. 마커가 있는 두 번째
 * 페이지의 첫 줄은 인쇄 번호가 아니므로 그 페이지 전체가 청킹에서 탈락한다. 따라서 원본 마커
 * 탐색은 true이고 GuidelineParseService의 §20 가드는 uniqueNumbers: 0으로 실패한다.
 */
const markerOnRejectedPageOnlyPages: string[] = [
  [
    '56',
    'IV 권고사항',
    '1 합성 단독 관찰',
    '이 페이지에는 권고 마커와 등급 표가 없다.',
  ].join('\n'),
  [
    '합성 머리말 — 인쇄 번호가 아님',
    'IV 권고사항',
    '【 R1 】',
    '권고안 권고등급/근거수준 참고문헌',
    '별모래성 흐림에는 달빛 관찰을 고려할 수 있다. B/Moderate 1)',
  ].join('\n'),
];

const renderLogValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

describe('이슈 #144: 대상 아님 목록의 PARSE 실패 fallback', () => {
  jest.setTimeout(180_000);

  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication | undefined;
  let admin: TestSession;

  const fakeSource = new FakeGuidelineSource();
  const fakePdfExtractor = new FakePdfExtractor();
  const failingEmbedding = new FailingEmbeddingProvider();

  /** 각 테스트가 필요한 합성 항목만 주입한다. */
  const injectedTargets: NotIngestTarget[] = [];
  const fakeListProvider = {
    knownSourceDefects: () => [],
    notIngestTargets: () => injectedTargets,
  };

  const currentApp = (): INestApplication => {
    if (!app) throw new Error('Nest 애플리케이션이 기동되지 않았습니다.');
    return app;
  };

  const syntheticBody = (externalId: string): Buffer =>
    Buffer.from(`%PDF-1.7\nDOC:${externalId}\nissue-144 synthetic fixture`);

  const syntheticHash = (externalId: string): string =>
    createHash('sha256').update(syntheticBody(externalId)).digest('hex');

  const listedTarget = (
    externalId: string,
    reason: string,
    version = SYNTHETIC_VERSION,
  ): NotIngestTarget => ({
    sourceSystem: 'NCKM',
    externalId,
    version,
    fileHash: syntheticHash(externalId),
    reason,
  });

  const sourceItem = (
    externalId: string,
    version = SYNTHETIC_VERSION,
  ): SourceListItem => ({
    externalId,
    title: `이슈 144 합성 지침 ${externalId}`,
    publisher: '가상별빛학회',
    releaseDate: version,
    sourceUrl: `https://example.test/guidelines/${externalId}`,
    fileName: `${externalId}.pdf`,
  });

  const addPdf = (
    externalId: string,
    pages: string[],
    version = SYNTHETIC_VERSION,
  ): void => {
    fakeSource.addDocument(sourceItem(externalId, version), {
      body: syntheticBody(externalId),
      contentType: 'application/pdf',
    });
    fakePdfExtractor.setPagesFor(`DOC:${externalId}`, pages);
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

  const runFor = (completed: JobDetailDto, externalId: string): RunDto => {
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
      .overrideProvider(GuidelineListProvider)
      .useValue(fakeListProvider)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.listen(0);

    admin = await socialSignUp(currentApp(), {
      email: 'guideline-parse-fallback-admin@clinic.kr',
      providerId: 'guideline-parse-fallback-admin',
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
    injectedTargets.length = 0;
  });

  afterAll(async () => {
    fakeSource.resumeDownloads();
    await app?.close();
    await pool?.end();
    await postgresContainer?.stop();
    await redisContainer?.stop();
  });

  it('검증 포인트 1a: 마커 관측 후 파싱 실패해도 목록 일치 문서는 SKIPPED/PARSE로 종결한다', async () => {
    const listed = listedTarget(
      'issue-144-listed-1a',
      '합성 작성 안내서라 인제스트 대상이 아니다 — 검증 포인트 1a',
    );
    injectedTargets.push(listed);
    addPdf(
      listed.externalId,
      markerOnRejectedPageOnlyPages,
      listed.version,
    );

    const created = await startJob();
    const completed = await waitForJob(created.id);
    const run = runFor(completed, listed.externalId);

    expect(run).toMatchObject({
      status: 'SKIPPED',
      phase: 'PARSE',
    });
    expect(run.status).not.toBe('FAILED');
  });

  it('검증 포인트 1b: fallback으로 SKIPPED된 실행에는 실패 정보를 남기지 않는다', async () => {
    const listed = listedTarget(
      'issue-144-listed-1b',
      '합성 작성 안내서라 인제스트 대상이 아니다 — 검증 포인트 1b',
    );
    injectedTargets.push(listed);
    addPdf(
      listed.externalId,
      markerOnRejectedPageOnlyPages,
      listed.version,
    );

    const created = await startJob();
    const completed = await waitForJob(created.id);
    const run = runFor(completed, listed.externalId);

    expect(run).toMatchObject({
      status: 'SKIPPED',
      phase: 'PARSE',
      errorCode: null,
      error: null,
    });
  });

  it('검증 포인트 1c: fallback 실행은 잡의 skipped에만 집계하고 failed에는 넣지 않는다', async () => {
    const listed = listedTarget(
      'issue-144-listed-1c',
      '합성 작성 안내서라 인제스트 대상이 아니다 — 검증 포인트 1c',
    );
    injectedTargets.push(listed);
    addPdf(
      listed.externalId,
      markerOnRejectedPageOnlyPages,
      listed.version,
    );

    const created = await startJob();
    const completed = await waitForJob(created.id);
    const run = runFor(completed, listed.externalId);

    expect(run).toMatchObject({
      status: 'SKIPPED',
      phase: 'PARSE',
    });
    expect(completed).toMatchObject({
      total: 1,
      processed: 1,
      succeeded: 0,
      skipped: 1,
      failed: 0,
    });
    expect(completed.processed).toBe(
      completed.succeeded + completed.skipped + completed.failed,
    );
  });

  it('검증 포인트 2a: 목록 문서에서 마커가 관측된 fallback은 목록 사유를 포함한 경고를 남긴다', async () => {
    const listed = listedTarget(
      'issue-144-listed-2a',
      '합성 작성 안내서의 권고문 예시이므로 판정 재검토가 필요하다 — 검증 포인트 2a',
    );
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      injectedTargets.push(listed);
      addPdf(
        listed.externalId,
        markerOnRejectedPageOnlyPages,
        listed.version,
      );

      const created = await startJob();
      const completed = await waitForJob(created.id);
      const run = runFor(completed, listed.externalId);
      const warnings = warnSpy.mock.calls
        .flat()
        .map(renderLogValue)
        .join('\n');

      expect(warnings).toContain(listed.reason);
      expect(warnings).toEqual(expect.stringMatching(/마커|marker/i));
      expect(warnings).toEqual(
        expect.stringMatching(/목록|대상\s*아님|not[\s_-]*ingest|listed/i),
      );
      expect(run).toMatchObject({
        status: 'SKIPPED',
        phase: 'PARSE',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('검증 포인트 3a: 마커 관측 후 파싱 실패한 목록 밖 문서는 여전히 FAILED다', async () => {
    const listed = listedTarget(
      'issue-144-listed-control-3a',
      '구 구현을 죽이는 목록 일치 fallback 대조군 — 검증 포인트 3a',
    );
    const unlistedExternalId = 'issue-144-unlisted-3a';
    injectedTargets.push(listed);
    addPdf(
      listed.externalId,
      markerOnRejectedPageOnlyPages,
      listed.version,
    );
    addPdf(unlistedExternalId, markerOnRejectedPageOnlyPages);

    const created = await startJob();
    const completed = await waitForJob(created.id);
    const unlistedRun = runFor(completed, unlistedExternalId);
    const listedRun = runFor(completed, listed.externalId);

    expect(unlistedRun).toMatchObject({
      status: 'FAILED',
      phase: 'PARSE',
    });
    expect(unlistedRun.status).not.toBe('SKIPPED');

    // 이 대조군 단언으로 회귀 검증만 선반영한 현재 구현도 이 테스트를 통과하지 못한다.
    expect(listedRun).toMatchObject({
      status: 'SKIPPED',
      phase: 'PARSE',
    });
    expect(completed).toMatchObject({
      total: 2,
      processed: 2,
      succeeded: 0,
      skipped: 1,
      failed: 1,
    });
  });

  it('검증 포인트 3b: 목록 밖 PARSE 실패에는 GUIDELINE_PARSE_FAILED를 기록한다', async () => {
    const listed = listedTarget(
      'issue-144-listed-control-3b',
      '구 구현을 죽이는 목록 일치 fallback 대조군 — 검증 포인트 3b',
    );
    const unlistedExternalId = 'issue-144-unlisted-3b';
    injectedTargets.push(listed);
    addPdf(
      listed.externalId,
      markerOnRejectedPageOnlyPages,
      listed.version,
    );
    addPdf(unlistedExternalId, markerOnRejectedPageOnlyPages);

    const created = await startJob();
    const completed = await waitForJob(created.id);
    const unlistedRun = runFor(completed, unlistedExternalId);
    const listedRun = runFor(completed, listed.externalId);

    expect(unlistedRun).toMatchObject({
      status: 'FAILED',
      phase: 'PARSE',
      errorCode: 'GUIDELINE_PARSE_FAILED',
      error: expect.stringMatching(/\S/),
      guidelineVersionId: null,
    });

    // 같은 잡의 목록 일치 문서는 새 fallback을 반드시 타야 하므로 현재 구현에서는 실패한다.
    expect(listedRun).toMatchObject({
      status: 'SKIPPED',
      phase: 'PARSE',
      errorCode: null,
      error: null,
    });
  });

  it('검증 포인트 4a: 목록 문서라도 파싱 성공하면 PARSE에서 SKIPPED하지 않는다', async () => {
    const fallbackTarget = listedTarget(
      'issue-144-listed-control-4a',
      '구 구현을 죽이는 목록 일치 fallback 대조군 — 검증 포인트 4a',
    );
    const parseSuccessTarget = listedTarget(
      'issue-144-listed-parse-success-4a',
      '정상 파싱이 목록보다 우선해야 하는 합성 항목 — 검증 포인트 4a',
    );
    injectedTargets.push(fallbackTarget, parseSuccessTarget);
    addPdf(
      fallbackTarget.externalId,
      markerOnRejectedPageOnlyPages,
      fallbackTarget.version,
    );
    addPdf(
      parseSuccessTarget.externalId,
      parenthesizedCoordinatePages,
      parseSuccessTarget.version,
    );

    const created = await startJob();
    const completed = await waitForJob(created.id);
    const parseSuccessRun = runFor(completed, parseSuccessTarget.externalId);
    const fallbackRun = runFor(completed, fallbackTarget.externalId);
    const parse = parseSuccessRun.stages.parse as ParseStageDto | undefined;

    expect(parseSuccessRun.status).not.toBe('SKIPPED');
    expect(['SUCCEEDED', 'FAILED']).toContain(parseSuccessRun.status);
    expect(parse).toBeDefined();
    expect(parse?.pages).toBe(parenthesizedCoordinatePages.length);
    expect(parse?.chunks).toBeGreaterThan(0);

    // 성공 파싱 회귀 그물도 새 fallback과 한 잡에서 함께 검증해 현재 구현을 죽인다.
    expect(fallbackRun).toMatchObject({
      status: 'SKIPPED',
      phase: 'PARSE',
    });
  });

  it('검증 포인트 4b: 목록의 파싱 성공 문서는 정상 적재 또는 PARSE 이후 단계까지 진행한다', async () => {
    const fallbackTarget = listedTarget(
      'issue-144-listed-control-4b',
      '구 구현을 죽이는 목록 일치 fallback 대조군 — 검증 포인트 4b',
    );
    const parseSuccessTarget = listedTarget(
      'issue-144-listed-parse-success-4b',
      '정상 파싱 뒤 후속 단계로 진행해야 하는 합성 항목 — 검증 포인트 4b',
    );
    injectedTargets.push(fallbackTarget, parseSuccessTarget);
    addPdf(
      fallbackTarget.externalId,
      markerOnRejectedPageOnlyPages,
      fallbackTarget.version,
    );
    addPdf(
      parseSuccessTarget.externalId,
      parenthesizedCoordinatePages,
      parseSuccessTarget.version,
    );

    const created = await startJob();
    const completed = await waitForJob(created.id);
    const parseSuccessRun = runFor(completed, parseSuccessTarget.externalId);
    const fallbackRun = runFor(completed, fallbackTarget.externalId);
    const parse = parseSuccessRun.stages.parse as ParseStageDto | undefined;

    expect(parseSuccessRun.status).not.toBe('SKIPPED');
    expect(['SUCCEEDED', 'FAILED']).toContain(parseSuccessRun.status);
    expect(['EMBED', 'INGEST']).toContain(parseSuccessRun.phase);
    expect(parse?.chunks).toBeGreaterThan(0);

    // 이 대조군이 기존의 "PARSE catch는 무조건 FAILED" 구현을 직접 죽인다.
    expect(fallbackRun).toMatchObject({
      status: 'SKIPPED',
      phase: 'PARSE',
      errorCode: null,
      error: null,
    });
  });
});
