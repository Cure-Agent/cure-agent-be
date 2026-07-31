/**
 * docs/specs/26 수용 기준 동결 테스트.
 *
 * 합성 PDF 버퍼와 합성 추출 페이지만 사용한다. 모든 스캔은 크론 발화를 기다리지 않고
 * GuidelineRevisionScanService.scan()을 직접 호출한다(기준 32).
 *
 * 부정 단언은 같은 it의 양성 대조군과 짝지었다. 따라서 RedisLock.acquire()가 언제나 null이고
 * scan()이 no-op인 현재 스텁에서는 이 파일의 모든 it이 실패한다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
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
import type Redis from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  REVISION_SCAN_LOCK_KEY,
  GuidelineRevisionScanService,
} from '../src/domain/guideline/service/guideline-revision-scan.service';
import { GuidelineListProvider } from '../src/domain/guideline/service/guideline-list.provider';
import { type KnownSourceDefect } from '../src/domain/guideline/service/known-source-defects';
import { type NotIngestTarget } from '../src/domain/guideline/service/not-ingest-targets';
import {
  type AlertEvent,
  RealTimeAlertSender,
} from '../src/global/observability/real-time-alert.sender';
import { RedisLock } from '../src/global/redis/redis-lock';
import { REDIS } from '../src/global/redis/redis.token';
import { PdfTextExtractor } from '../src/infrastructure/document/pdf-text.extractor';
import { EMBEDDING_PROVIDER } from '../src/infrastructure/embedding/embedding-provider.port';
import {
  GUIDELINE_SOURCE,
  type SourceListItem,
} from '../src/infrastructure/guideline-source/guideline-source.port';
import {
  REVISION_SCAN_CRON_NAME,
} from '../src/infrastructure/scheduler/guideline-revision.cron';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { FailingEmbeddingProvider } from './fixtures/failing-embedding.provider';
import { FakeGuidelineSource } from './fixtures/fake-guideline-source';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { FakePdfExtractor } from './fixtures/fake-pdf-extractor';
import {
  nckmGradeMissingPages,
  nckmSamplePages,
} from './fixtures/nckm-pages.sample';
import { socialSignUp, type TestSession } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const JOB_TIMEOUT_MS = 30_000;
const SOURCE_MODIFIED_OLD = 'Jul 20, 2026 09:10:00 AM';
const SOURCE_MODIFIED_NEW = 'Jul 30, 2026 10:05:00 AM';
const SOURCE_MODIFIED_ISO = '2026-07-30T10:05:00';

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
  triggeredBy: 'MANUAL' | 'SCHEDULE';
  requestedBy: string | null;
  total: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  error: string | null;
}

interface RunDto {
  id: string;
  jobId: string | null;
  externalId: string | null;
  status: 'RUNNING' | 'SUCCEEDED' | 'SKIPPED' | 'FAILED' | 'INTERRUPTED';
  phase: 'ACQUIRE' | 'PARSE' | 'EMBED' | 'INGEST';
  errorCode: string | null;
  error: string | null;
  created: boolean | null;
}

interface JobDetailDto extends JobDto {
  runs: RunDto[];
}

interface SourceDocumentProbe {
  id: string;
  fileHash: string | null;
  sourceModifiedAt: string | null;
}

class EmptyGuidelineListProvider {
  knownSourceDefects(): KnownSourceDefect[] {
    return [];
  }

  notIngestTargets(): NotIngestTarget[] {
    return [];
  }
}

describe('spec 26: 지침 개정 감지 스케줄러', () => {
  jest.setTimeout(180_000);

  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication | undefined;
  let admin: TestSession;
  let scan: GuidelineRevisionScanService;
  let redisLock: RedisLock;
  let redis: Redis;

  const fakeSource = new FakeGuidelineSource();
  const fakePdfExtractor = new FakePdfExtractor();
  const failingEmbedding = new FailingEmbeddingProvider();
  const emptyGuidelineLists = new EmptyGuidelineListProvider();
  const sendAlert = jest.fn((event: AlertEvent): void => {
    void event;
  });
  const fakeAlertSender: Pick<RealTimeAlertSender, 'send'> = {
    send: sendAlert,
  };

  const currentApp = (): INestApplication => {
    if (!app) throw new Error('Nest 애플리케이션이 기동되지 않았습니다.');
    return app;
  };

  const restoreEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

  const createApplication = async ({
    scanEnabled,
    listen,
  }: {
    scanEnabled: boolean | undefined;
    listen: boolean;
  }): Promise<INestApplication> => {
    const previousEnabled =
      process.env.GUIDELINE_REVISION_SCAN_ENABLED;
    const previousCron = process.env.GUIDELINE_REVISION_SCAN_CRON;

    if (scanEnabled === undefined) {
      delete process.env.GUIDELINE_REVISION_SCAN_ENABLED;
    } else {
      process.env.GUIDELINE_REVISION_SCAN_ENABLED = String(scanEnabled);
    }
    // 등록 여부만 검사하므로 테스트 중 발화할 가능성이 낮은 고정식을 쓴다.
    process.env.GUIDELINE_REVISION_SCAN_CRON = '0 0 1 1 *';

    try {
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
        .useValue(emptyGuidelineLists)
        .overrideProvider(RealTimeAlertSender)
        .useValue(fakeAlertSender)
        .compile();

      const nextApp = moduleRef.createNestApplication();
      nextApp.setGlobalPrefix('api/v1');
      nextApp.use(cookieParser());
      if (listen) {
        await nextApp.listen(0);
      } else {
        await nextApp.init();
      }
      return nextApp;
    } finally {
      restoreEnv('GUIDELINE_REVISION_SCAN_ENABLED', previousEnabled);
      restoreEnv('GUIDELINE_REVISION_SCAN_CRON', previousCron);
    }
  };

  const sourceItem = (
    externalId: string,
    sourceModifiedAt: string | null | undefined = SOURCE_MODIFIED_NEW,
  ): SourceListItem => ({
    externalId,
    title: `합성 개정 감지 지침 ${externalId}`,
    publisher: '가상별빛학회',
    releaseDate: '2026-08',
    sourceModifiedAt,
    sourceUrl: `https://example.test/guidelines/${externalId}`,
    fileName: `${externalId}.pdf`,
  });

  const syntheticPdfBody = (externalId: string): Buffer =>
    Buffer.from(
      `%PDF-1.7\nDOC:${externalId}\nsynthetic guideline revision fixture`,
    );

  const addPdf = (
    externalId: string,
    sourceModifiedAt: string | null | undefined = SOURCE_MODIFIED_NEW,
    pages: string[] = nckmSamplePages,
  ): Buffer => {
    const body = syntheticPdfBody(externalId);
    fakeSource.addDocument(sourceItem(externalId, sourceModifiedAt), {
      body,
      contentType: 'application/pdf',
    });
    fakePdfExtractor.setPagesFor(`DOC:${externalId}`, pages);
    return body;
  };

  const addDownloadFailure = (
    externalId: string,
    sourceModifiedAt: string | null | undefined = SOURCE_MODIFIED_NEW,
  ): void => {
    fakeSource.addItem(sourceItem(externalId, sourceModifiedAt));
    fakeSource.setFailure(externalId);
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

  const waitForJob = async (
    jobId: string,
    expectedStatuses: JobStatus[] = [
      'COMPLETED',
      'CANCELLED',
      'INTERRUPTED',
      'FAILED',
    ],
  ): Promise<JobDetailDto> => {
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    let last: JobDetailDto | undefined;

    while (Date.now() < deadline) {
      last = await getJob(jobId);
      if (expectedStatuses.includes(last.status)) return last;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    throw new Error(
      `잡 ${jobId}가 ${JOB_TIMEOUT_MS}ms 안에 끝나지 않았습니다. ` +
        `마지막 상태=${last?.status ?? '조회 전'}`,
    );
  };

  const startManualJob = async (externalIds: string[]): Promise<JobDto> => {
    const response = await request(currentApp().getHttpServer())
      .post('/api/v1/admin/guideline-jobs')
      .set(CSRF)
      .set('Cookie', admin.cookie)
      .send({ externalIds });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      success: true,
      code: 'SUCCESS',
      data: {
        status: 'RUNNING',
      },
    });
    const job = response.body.data as JobDto;
    expect(job.id).toEqual(expect.any(String));
    return job;
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

  const listScheduledJobIds = async (): Promise<string[]> => {
    const result = await pool.query(
      `
        SELECT id
        FROM guideline_jobs
        WHERE triggered_by = 'SCHEDULE'
        ORDER BY id
      `,
    );
    return result.rows.map((row) => row.id as string);
  };

  const jobCount = async (): Promise<number> => {
    const result = await pool.query(
      `SELECT count(*)::int AS count FROM guideline_jobs`,
    );
    return result.rows[0].count as number;
  };

  const pipelineRunCount = async (): Promise<number> => {
    const result = await pool.query(
      `SELECT count(*)::int AS count FROM pipeline_runs`,
    );
    return result.rows[0].count as number;
  };

  const runExternalIds = async (jobId: string): Promise<string[]> => {
    const result = await pool.query(
      `
        SELECT external_id
        FROM pipeline_runs
        WHERE job_id = $1
        ORDER BY "order"
      `,
      [jobId],
    );
    return result.rows.map((row) => row.external_id as string);
  };

  const sourceDocumentRows = async (
    externalId: string,
  ): Promise<SourceDocumentProbe[]> => {
    const result = await pool.query(
      `
        SELECT
          id,
          file_hash AS "fileHash",
          source_modified_at AS "sourceModifiedAt"
        FROM source_documents
        WHERE source_system = $1
          AND external_id = $2
        ORDER BY id
      `,
      [fakeSource.system, externalId],
    );
    return result.rows as SourceDocumentProbe[];
  };

  const fullScanListCallCount = (): number =>
    fakeSource.listCalls.filter(
      (call) => call.externalIds === undefined,
    ).length;

  const scanAndGetCreatedJob = async (): Promise<JobDetailDto> => {
    const before = new Set(await listScheduledJobIds());

    // 기준 32: 시간·크론식을 기다리지 않고 서비스 진입점을 직접 호출한다.
    await scan.scan();

    const after = await listScheduledJobIds();
    const createdIds = after.filter((jobId) => !before.has(jobId));
    expect(createdIds).toHaveLength(1);
    if (createdIds.length !== 1) {
      throw new Error(
        `스캔이 만든 SCHEDULE 잡은 1건이어야 합니다: ${createdIds.join(', ')}`,
      );
    }
    return getJob(createdIds[0]);
  };

  const scanAndWaitForJob = async (): Promise<JobDetailDto> => {
    const created = await scanAndGetCreatedJob();
    return waitForJob(created.id);
  };

  const clearJobHistory = async (): Promise<void> => {
    await pool.query(`DELETE FROM pipeline_runs`);
    await pool.query(`DELETE FROM guideline_jobs`);
  };

  const seedFetchedDocument = async (
    externalId: string,
    sourceModifiedAt: string | null,
  ): Promise<Buffer> => {
    const body = addPdf(externalId, sourceModifiedAt);
    const created = await startManualJob([externalId]);
    const completed = await waitForJob(created.id);
    expect(runFor(completed, externalId)).toMatchObject({
      status: 'SUCCEEDED',
      phase: 'INGEST',
    });

    const updated = await pool.query(
      `
        UPDATE source_documents
        SET source_modified_at = $1
        WHERE source_system = $2
          AND external_id = $3
          AND file_hash IS NOT NULL
      `,
      [sourceModifiedAt, fakeSource.system, externalId],
    );
    expect(updated.rowCount).toBeGreaterThan(0);

    // 준비용 MANUAL 잡은 관찰 대상인 SCHEDULE 잡과 섞지 않는다.
    await clearJobHistory();
    sendAlert.mockClear();
    return body;
  };

  const requiredAlert = (): AlertEvent => {
    const event = sendAlert.mock.calls[0]?.[0];
    expect(event).toBeDefined();
    if (!event) throw new Error('개정 스캔 알림 호출을 찾지 못했습니다.');
    return event;
  };

  const waitForAlertCalls = async (
    count: number,
    timeoutMs = 2_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (
      sendAlert.mock.calls.length < count &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(sendAlert.mock.calls.length).toBeGreaterThanOrEqual(count);
  };

  const alertText = (event: AlertEvent): string =>
    `${event.title}\n${event.detail ?? ''}`;

  const expectAlertCounter = (
    text: string,
    field: 'total' | 'succeeded' | 'skipped' | 'failed',
    value: number,
  ): void => {
    expect(text).toMatch(
      new RegExp(
        `${field}["']?\\s*[:=]?\\s*${value}(?:\\D|$)`,
        'i',
      ),
    );
  };

  const clearPersistence = async (): Promise<void> => {
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
  };

  const resetScenario = async (): Promise<void> => {
    jest.restoreAllMocks();
    fakeSource.resumeDownloads();
    await clearPersistence();
    fakeSource.reset();
    fakePdfExtractor.reset();
    failingEmbedding.reset();
    sendAlert.mockReset();
    sendAlert.mockImplementation((event: AlertEvent): void => {
      void event;
    });
    await redis.del(REVISION_SCAN_LOCK_KEY);
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

    app = await createApplication({
      scanEnabled: false,
      listen: true,
    });
    scan = currentApp().get(GuidelineRevisionScanService);
    redisLock = currentApp().get(RedisLock);
    redis = currentApp().get<Redis>(REDIS);

    admin = await socialSignUp(currentApp(), {
      email: 'guideline-revision-scan-admin@clinic.kr',
      providerId: 'guideline-revision-scan-admin',
    });
    await pool.query(`UPDATE clinicians SET role = 'ADMIN' WHERE id = $1`, [
      admin.clinicianId,
    ]);
  });

  beforeEach(async () => {
    await resetScenario();
  });

  afterAll(async () => {
    fakeSource.resumeDownloads();
    if (redis?.status === 'end') {
      await redis.connect().catch(() => undefined);
    }
    await app?.close();
    await pool?.end();
    await postgresContainer?.stop();
    await redisContainer?.stop();
  });

  it('기준 1a·8a: 본문을 받은 행이 없는 신규 문서는 잡 대상이 되고 새 행에 목록 baseline을 기록한다', async () => {
    const externalId = 'synthetic-new-708';
    addPdf(externalId, SOURCE_MODIFIED_NEW);

    const completed = await scanAndWaitForJob();
    const run = runFor(completed, externalId);

    expect(completed).toMatchObject({
      triggeredBy: 'SCHEDULE',
      requestedBy: null,
      total: 1,
    });
    expect(run).toMatchObject({
      externalId,
      status: 'SUCCEEDED',
      phase: 'INGEST',
      created: true,
    });
    expect(await runExternalIds(completed.id)).toEqual([externalId]);

    const documents = await sourceDocumentRows(externalId);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      fileHash: expect.any(String),
      sourceModifiedAt: SOURCE_MODIFIED_NEW,
    });
  });

  it('기준 2a·3a·4a·17a·17b: 문자열이 다른 두 후보만 위임하고 같은 문서는 실행 행조차 만들지 않는다', async () => {
    const changed = 'candidate-modified-differs';
    const equal = 'non-candidate-modified-equal';
    const formattingChanged = 'candidate-string-format-differs';

    await seedFetchedDocument(changed, SOURCE_MODIFIED_OLD);
    await seedFetchedDocument(equal, SOURCE_MODIFIED_NEW);
    await seedFetchedDocument(formattingChanged, SOURCE_MODIFIED_NEW);

    // 같은 버퍼를 다시 등록해 후보 판정 축을 오직 sourceModifiedAt 문자열로 고정한다.
    addPdf(changed, SOURCE_MODIFIED_NEW);
    addPdf(equal, SOURCE_MODIFIED_NEW);
    addPdf(formattingChanged, SOURCE_MODIFIED_ISO);

    const callsBefore = fakeSource.listCalls.length;
    const completed = await scanAndWaitForJob();
    const ids = await runExternalIds(completed.id);
    const delegatedCall = fakeSource.listCalls
      .slice(callsBefore)
      .find((call) => call.externalIds !== undefined);

    expect(completed.total).toBe(2);
    expect([...(delegatedCall?.externalIds ?? [])].sort()).toEqual(
      [changed, formattingChanged].sort(),
    );
    expect(ids.sort()).toEqual([changed, formattingChanged].sort());
    expect(completed.runs.map((run) => run.externalId).sort()).toEqual(
      [changed, formattingChanged].sort(),
    );
    expect(ids).not.toContain(equal);
    expect(completed.runs.some((run) => run.externalId === equal)).toBe(false);

    // ISO 표기와 NCKM 영문 표기는 날짜 객체로 정규화하지 않고 다른 문자열로 취급한다.
    expect(runFor(completed, formattingChanged)).toMatchObject({
      status: 'SUCCEEDED',
      created: false,
    });
  });

  it('기준 5c 연계: 목록에 수정일·등록일이 없어 sourceModifiedAt을 모르면 기존 본문이 있어도 후보로 잡는다', async () => {
    const externalId = 'candidate-with-unknown-source-date';
    await seedFetchedDocument(externalId, SOURCE_MODIFIED_OLD);
    addPdf(externalId, null);

    const completed = await scanAndWaitForJob();

    expect(completed.total).toBe(1);
    expect(await runExternalIds(completed.id)).toEqual([externalId]);
    expect(runFor(completed, externalId).status).toBe('SUCCEEDED');
  });

  it('기준 6a·7a: file_hash NULL 실패 행만 있는 문서는 후보이고 목록에서 사라진 문서는 대상이 아니다', async () => {
    const failedOnly = 'candidate-with-null-file-hash';
    const disappeared = 'stored-but-not-listed';

    await seedFetchedDocument(failedOnly, SOURCE_MODIFIED_OLD);
    await seedFetchedDocument(disappeared, SOURCE_MODIFIED_OLD);
    const nulled = await pool.query(
      `
        UPDATE source_documents
        SET file_hash = NULL,
            source_modified_at = NULL
        WHERE source_system = $1
          AND external_id = $2
      `,
      [fakeSource.system, failedOnly],
    );
    expect(nulled.rowCount).toBeGreaterThan(0);
    const failedRows = await sourceDocumentRows(failedOnly);
    expect(failedRows.length).toBeGreaterThan(0);
    expect(failedRows.every((row) => row.fileHash === null)).toBe(true);
    expect(await sourceDocumentRows(disappeared)).toHaveLength(1);

    // DB 상태는 보존하고 목록 fake만 갈아 끼워 disappeared를 목록에서 제거한다.
    fakeSource.reset();
    fakePdfExtractor.reset();
    addPdf(failedOnly, SOURCE_MODIFIED_NEW);

    const completed = await scanAndWaitForJob();
    const ids = await runExternalIds(completed.id);

    expect(completed.total).toBe(1);
    expect(ids).toEqual([failedOnly]);
    expect(ids).not.toContain(disappeared);
    expect(runFor(completed, failedOnly)).toMatchObject({
      status: 'SUCCEEDED',
    });
  });

  it('기준 9a: 같은 해시를 다시 받으면 source_documents 행 수는 유지하고 기존 baseline만 갱신한다', async () => {
    const externalId = 'same-hash-baseline-touch';
    await seedFetchedDocument(externalId, SOURCE_MODIFIED_OLD);
    const before = await sourceDocumentRows(externalId);
    expect(before).toHaveLength(1);
    expect(before[0].sourceModifiedAt).toBe(SOURCE_MODIFIED_OLD);

    addPdf(externalId, SOURCE_MODIFIED_NEW);
    const completed = await scanAndWaitForJob();
    const run = runFor(completed, externalId);
    const after = await sourceDocumentRows(externalId);

    expect(run).toMatchObject({
      status: 'SUCCEEDED',
      created: false,
    });
    expect(after).toHaveLength(before.length);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after[0].sourceModifiedAt).toBe(SOURCE_MODIFIED_NEW);
  });

  it('기준 10a·10b: 다운로드 실패에는 baseline을 쓰지 않고 다음 scan에서 같은 문서를 다시 위임한다', async () => {
    const externalId = 'download-failure-retried';
    addDownloadFailure(externalId, SOURCE_MODIFIED_NEW);

    const first = await scanAndWaitForJob();
    expect(runFor(first, externalId)).toMatchObject({
      status: 'FAILED',
      phase: 'ACQUIRE',
      errorCode: 'GUIDELINE_SOURCE_UNAVAILABLE',
    });
    const afterFirst = await sourceDocumentRows(externalId);
    expect(
      afterFirst.filter((row) => row.sourceModifiedAt !== null),
    ).toHaveLength(0);

    const second = await scanAndWaitForJob();
    expect(second.id).not.toBe(first.id);
    expect(runFor(second, externalId)).toMatchObject({
      status: 'FAILED',
      phase: 'ACQUIRE',
      errorCode: 'GUIDELINE_SOURCE_UNAVAILABLE',
    });

    const runs = await pool.query(
      `
        SELECT job_id
        FROM pipeline_runs
        WHERE external_id = $1
        ORDER BY job_id
      `,
      [externalId],
    );
    expect(runs.rows).toHaveLength(2);
    expect(new Set(runs.rows.map((row) => row.job_id)).size).toBe(2);
  });

  it('기준 11a: 다운로드 뒤 PARSE 실패에는 baseline을 쓰고 다음 scan에서는 다시 위임하지 않는다', async () => {
    const externalId = 'parse-failure-baseline-stops-retry';
    addPdf(
      externalId,
      SOURCE_MODIFIED_NEW,
      nckmGradeMissingPages,
    );

    const first = await scanAndWaitForJob();
    expect(runFor(first, externalId)).toMatchObject({
      status: 'FAILED',
      phase: 'PARSE',
      errorCode: 'GUIDELINE_PARSE_FAILED',
    });
    const documents = await sourceDocumentRows(externalId);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      fileHash: expect.any(String),
      sourceModifiedAt: SOURCE_MODIFIED_NEW,
    });

    const jobsBefore = await jobCount();
    const runsBefore = await pipelineRunCount();
    const listCallsBefore = fullScanListCallCount();
    await scan.scan();

    expect(fullScanListCallCount()).toBe(listCallsBefore + 1);
    expect(await jobCount()).toBe(jobsBefore);
    expect(await pipelineRunCount()).toBe(runsBefore);
  });

  it('기준 12a·13a·13b: 빈 락에서는 실제 스캔하고 선점된 락에서는 목록 조회와 잡 생성을 모두 건너뛴다', async () => {
    addPdf('lock-positive-control', SOURCE_MODIFIED_NEW);
    const control = await scanAndWaitForJob();
    expect(control.total).toBe(1);
    expect(fullScanListCallCount()).toBe(1);

    addPdf('locked-tick-must-not-scan', SOURCE_MODIFIED_NEW);
    const listCallsBefore = fullScanListCallCount();
    const jobsBefore = await jobCount();
    await redis.set(
      REVISION_SCAN_LOCK_KEY,
      'someone-else',
      'PX',
      60_000,
    );

    try {
      await scan.scan();
      expect(fullScanListCallCount()).toBe(listCallsBefore);
      expect(await jobCount()).toBe(jobsBefore);
    } finally {
      await redis.del(REVISION_SCAN_LOCK_KEY);
    }
  });

  it('기준 14a: Redis 연결이 끊겨 락 획득이 실패하면 fail-closed로 목록과 잡을 건드리지 않는다', async () => {
    addPdf('redis-outage-positive-control', SOURCE_MODIFIED_NEW);
    const control = await scanAndWaitForJob();
    expect(control.status).toBe('COMPLETED');

    addPdf('redis-outage-target', SOURCE_MODIFIED_NEW);
    const listCallsBefore = fullScanListCallCount();
    const jobsBefore = await jobCount();
    redis.disconnect();

    try {
      await scan.scan();
      expect(fullScanListCallCount()).toBe(listCallsBefore);
      expect(await jobCount()).toBe(jobsBefore);
    } finally {
      await redis.connect();
    }
  });

  it('기준 15a: 락은 양수 TTL을 가지며 만료 뒤의 직접 scan은 정상 진행한다', async () => {
    const token = await redisLock.acquire(REVISION_SCAN_LOCK_KEY, 500);
    expect(token).toEqual(expect.any(String));
    if (!token) throw new Error('TTL 검증용 Redis 락을 얻지 못했습니다.');

    const ttl = await redis.pttl(REVISION_SCAN_LOCK_KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(500);

    await new Promise<void>((resolve) => setTimeout(resolve, 650));
    expect(await redis.exists(REVISION_SCAN_LOCK_KEY)).toBe(0);

    addPdf('scan-after-lock-ttl', SOURCE_MODIFIED_NEW);
    const completed = await scanAndWaitForJob();
    expect(completed.total).toBe(1);
  });

  it('기준 16a·16b: 성공 시 잡이 도는 동안 이미 락을 풀고 목록 예외 때도 finally로 락을 해제한다', async () => {
    addPdf('release-on-success-control', SOURCE_MODIFIED_NEW);
    fakeSource.pauseDownloads();
    let runningJobId: string | undefined;

    try {
      const running = await scanAndGetCreatedJob();
      runningJobId = running.id;
      await fakeSource.waitForDownloads(1);
      expect((await getJob(running.id)).status).toBe('RUNNING');
      expect(await redis.exists(REVISION_SCAN_LOCK_KEY)).toBe(0);
    } finally {
      fakeSource.resumeDownloads();
      if (runningJobId) {
        await waitForJob(runningJobId).catch(() => undefined);
      }
    }

    await resetScenario();
    const listFailure = jest
      .spyOn(fakeSource, 'listGuidelines')
      .mockRejectedValueOnce(new Error('synthetic list failure for release'));

    await scan.scan();

    expect(listFailure).toHaveBeenCalledTimes(1);
    expect(await redis.exists(REVISION_SCAN_LOCK_KEY)).toBe(0);
    expect(await jobCount()).toBe(0);
  });

  it('기준 18a·29a: 후보 0건 틱은 목록까지 조회하지만 잡과 알림을 만들지 않는다', async () => {
    const externalId = 'zero-candidate-after-control';
    addPdf(externalId, SOURCE_MODIFIED_NEW);

    // 양성 대조: 첫 틱은 신규 문서를 실제 처리하고 잡 결과 알림도 보낸다.
    const control = await scanAndWaitForJob();
    expect(control.total).toBe(1);
    await waitForAlertCalls(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);

    const jobsBefore = await jobCount();
    const runsBefore = await pipelineRunCount();
    const listCallsBefore = fullScanListCallCount();
    sendAlert.mockClear();

    await scan.scan();

    expect(fullScanListCallCount()).toBe(listCallsBefore + 1);
    expect(await jobCount()).toBe(jobsBefore);
    expect(await pipelineRunCount()).toBe(runsBefore);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('기준 19a·19b·20a·20b·21a·21b: MANUAL과 SCHEDULE 주체를 저장하고 상세 응답만으로 구분한다', async () => {
    const manualExternalId = 'manual-trigger-metadata';
    addPdf(manualExternalId, SOURCE_MODIFIED_NEW);
    const manualCreated = await startManualJob([manualExternalId]);
    expect(manualCreated).toMatchObject({
      triggeredBy: 'MANUAL',
      requestedBy: admin.clinicianId,
    });
    const manual = await waitForJob(manualCreated.id);
    expect(manual).toMatchObject({
      triggeredBy: 'MANUAL',
      requestedBy: admin.clinicianId,
    });

    const scheduledExternalId = 'scheduled-trigger-metadata';
    addPdf(scheduledExternalId, SOURCE_MODIFIED_NEW);
    const scheduled = await scanAndWaitForJob();
    const detail = await getJob(scheduled.id);

    expect(detail).toMatchObject({
      triggeredBy: 'SCHEDULE',
      requestedBy: null,
    });
    const stored = await pool.query(
      `
        SELECT
          triggered_by AS "triggeredBy",
          requested_by AS "requestedBy"
        FROM guideline_jobs
        WHERE id = $1
      `,
      [scheduled.id],
    );
    expect(stored.rows).toEqual([
      {
        triggeredBy: 'SCHEDULE',
        requestedBy: null,
      },
    ]);
  });

  it('기준 22a·22b: RUNNING·CANCELLING 잡 동안 새 잡과 baseline을 만들지 않고 종결 뒤 같은 후보를 다시 잡는다', async () => {
    const blocker = 'active-manual-blocker';
    const candidate = 'candidate-blocked-by-active-job';
    addPdf(blocker, SOURCE_MODIFIED_NEW);
    addPdf(candidate, SOURCE_MODIFIED_NEW);
    fakeSource.pauseDownloads();

    let activeJobId: string | undefined;
    try {
      const active = await startManualJob([blocker]);
      activeJobId = active.id;
      await fakeSource.waitForDownloads(1);
      expect((await getJob(active.id)).status).toBe('RUNNING');

      const jobsWhileRunning = await jobCount();
      await scan.scan();
      expect(await jobCount()).toBe(jobsWhileRunning);
      expect(await listScheduledJobIds()).toHaveLength(0);

      const cancel = await request(currentApp().getHttpServer())
        .post(`/api/v1/admin/guideline-jobs/${active.id}/cancel`)
        .set(CSRF)
        .set('Cookie', admin.cookie)
        .send({});
      expect(cancel.status).toBe(200);
      expect(cancel.body.data.status).toBe('CANCELLING');

      await scan.scan();
      expect(await jobCount()).toBe(jobsWhileRunning);
      expect(await listScheduledJobIds()).toHaveLength(0);
      expect(await sourceDocumentRows(candidate)).toHaveLength(0);

      fakeSource.resumeDownloads();
      const cancelled = await waitForJob(active.id, ['CANCELLED']);
      expect(cancelled.status).toBe('CANCELLED');
      activeJobId = undefined;

      const scheduled = await scanAndWaitForJob();
      expect(scheduled.total).toBe(1);
      expect(runFor(scheduled, candidate)).toBeDefined();
      expect(await runExternalIds(scheduled.id)).toEqual([candidate]);
    } finally {
      fakeSource.resumeDownloads();
      if (activeJobId) {
        await waitForJob(activeJobId).catch(() => undefined);
      }
    }
  });

  it('기준 23a·25a·25b: SCHEDULE 잡 정상 종결은 ID와 네 카운트를 담은 알림을 정확히 1건 보낸다', async () => {
    addPdf('scheduled-completion-alert', SOURCE_MODIFIED_NEW);

    const completed = await scanAndWaitForJob();

    expect(completed).toMatchObject({
      status: 'COMPLETED',
      total: 1,
      succeeded: 1,
      skipped: 0,
      failed: 0,
    });
    await waitForAlertCalls(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    const text = alertText(requiredAlert());
    expect(text).toContain(completed.id);
    expectAlertCounter(text, 'total', completed.total);
    expectAlertCounter(text, 'succeeded', completed.succeeded);
    expectAlertCounter(text, 'skipped', completed.skipped);
    expectAlertCounter(text, 'failed', completed.failed);
  });

  it('기준 24a: 러너의 대상 목록 조회가 죽어 잡이 FAILED로 종결되어도 알림을 정확히 1건 보낸다', async () => {
    addPdf('runner-fatal-list-failure', SOURCE_MODIFIED_NEW);
    const listNormally = fakeSource.listGuidelines.bind(fakeSource);
    jest
      .spyOn(fakeSource, 'listGuidelines')
      .mockImplementation((options = {}) => {
        if (options.externalIds !== undefined) {
          return Promise.reject(
            new Error('synthetic runner fatal list failure'),
          );
        }
        return listNormally(options);
      });

    const failed = await scanAndWaitForJob();

    expect(failed.status).toBe('FAILED');
    expect(failed.triggeredBy).toBe('SCHEDULE');
    await waitForAlertCalls(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(alertText(requiredAlert())).toContain(failed.id);
  });

  it('기준 26a·26b: 실패 실행이 있는 종결 알림에는 externalId와 errorCode를 함께 싣는다', async () => {
    const externalId = 'alert-identifies-failed-document';
    addDownloadFailure(externalId, SOURCE_MODIFIED_NEW);

    const completed = await scanAndWaitForJob();
    const failedRun = runFor(completed, externalId);

    expect(completed).toMatchObject({
      status: 'COMPLETED',
      total: 1,
      succeeded: 0,
      skipped: 0,
      failed: 1,
    });
    expect(failedRun).toMatchObject({
      status: 'FAILED',
      phase: 'ACQUIRE',
      errorCode: 'GUIDELINE_SOURCE_UNAVAILABLE',
    });
    await waitForAlertCalls(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    const text = alertText(requiredAlert());
    expect(text).toContain(externalId);
    expect(text).toContain('GUIDELINE_SOURCE_UNAVAILABLE');
  });

  it('기준 27a: 같은 경계에서 SCHEDULE 종결은 알리고 MANUAL 종결은 알리지 않는다', async () => {
    addPdf('schedule-alert-positive-control', SOURCE_MODIFIED_NEW);
    const scheduled = await scanAndWaitForJob();
    expect(scheduled.status).toBe('COMPLETED');
    await waitForAlertCalls(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);

    sendAlert.mockClear();
    addPdf('manual-completion-no-alert', SOURCE_MODIFIED_NEW);
    const manualCreated = await startManualJob([
      'manual-completion-no-alert',
    ]);
    const manual = await waitForJob(manualCreated.id);

    expect(manual).toMatchObject({
      status: 'COMPLETED',
      triggeredBy: 'MANUAL',
      requestedBy: admin.clinicianId,
    });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('기준 28a: 목록 조회 실패로 잡이 생기지 않은 스캔도 조용히 삼키지 않고 알림을 보낸다', async () => {
    const listFailure = jest
      .spyOn(fakeSource, 'listGuidelines')
      .mockRejectedValueOnce(new Error('synthetic scan list failure'));

    await scan.scan();

    expect(listFailure).toHaveBeenCalledTimes(1);
    expect(await jobCount()).toBe(0);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(requiredAlert().title).toEqual(expect.any(String));
  });

  it('기준 30a: 알림 sender가 던져도 SCHEDULE 잡의 정상 결과를 FAILED로 뒤집지 않는다', async () => {
    sendAlert.mockImplementation(() => {
      throw new Error('synthetic alert channel failure');
    });
    addPdf('alert-throw-does-not-change-job', SOURCE_MODIFIED_NEW);

    const completed = await scanAndWaitForJob();

    await waitForAlertCalls(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(completed).toMatchObject({
      status: 'COMPLETED',
      triggeredBy: 'SCHEDULE',
      total: 1,
      processed: 1,
      succeeded: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it('기준 23·24 보강: SCHEDULE 잡의 CANCELLED 종결도 결과 알림 대상이다', async () => {
    const externalId = 'cancelled-schedule-alert';
    addPdf(externalId, SOURCE_MODIFIED_NEW);
    fakeSource.pauseDownloads();
    let jobId: string | undefined;

    try {
      const running = await scanAndGetCreatedJob();
      jobId = running.id;
      await fakeSource.waitForDownloads(1);

      const cancel = await request(currentApp().getHttpServer())
        .post(`/api/v1/admin/guideline-jobs/${running.id}/cancel`)
        .set(CSRF)
        .set('Cookie', admin.cookie)
        .send({});
      expect(cancel.status).toBe(200);
      expect(cancel.body.data.status).toBe('CANCELLING');

      fakeSource.resumeDownloads();
      const cancelled = await waitForJob(running.id, ['CANCELLED']);
      expect(cancelled.status).toBe('CANCELLED');
      await waitForAlertCalls(1);
      expect(sendAlert).toHaveBeenCalledTimes(1);
      expect(alertText(requiredAlert())).toContain(running.id);
      jobId = undefined;
    } finally {
      fakeSource.resumeDownloads();
      if (jobId) {
        await waitForJob(jobId).catch(() => undefined);
      }
    }
  });

  it('기준 31a·31b·32a: 기본 꺼짐은 cron 미등록, 켜짐은 이름 등록이며 e2e 본문은 scan을 직접 호출한다', async () => {
    let disabledApp: INestApplication | undefined;
    let enabledApp: INestApplication | undefined;

    try {
      disabledApp = await createApplication({
        scanEnabled: undefined,
        listen: false,
      });
      const disabledRegistry = disabledApp.get(SchedulerRegistry);
      expect(
        disabledRegistry.getCronJobs().has(REVISION_SCAN_CRON_NAME),
      ).toBe(false);

      enabledApp = await createApplication({
        scanEnabled: true,
        listen: false,
      });
      const enabledRegistry = enabledApp.get(SchedulerRegistry);
      expect(
        enabledRegistry.getCronJobs().has(REVISION_SCAN_CRON_NAME),
      ).toBe(true);
    } finally {
      await enabledApp?.close();
      await disabledApp?.close();
    }
  });
});
