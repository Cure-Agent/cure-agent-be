/**
 * docs/specs/22-guideline-bulk-job.md 수용 기준 동결 테스트.
 * 구현 중 이 파일 수정 금지 — 수정 필요 = 스펙 결함 → spec 개정 후 재동결.
 */
// 디스크 쓰기 여부만 관찰하고 실제 동작은 유지한다. Testcontainers의 파일 락도 실제로 써야 한다.
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    mkdir: jest.fn(actual.mkdir),
    writeFile: jest.fn(actual.writeFile),
  };
});

import { mkdir, writeFile } from 'node:fs/promises';
import { INestApplication } from '@nestjs/common';
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
import request, { Response as SupertestResponse } from 'supertest';
import { AppModule } from '../src/app.module';
import { PdfTextExtractor } from '../src/infrastructure/document/pdf-text.extractor';
import { EMBEDDING_PROVIDER } from '../src/infrastructure/embedding/embedding-provider.port';
import {
  GUIDELINE_SOURCE,
  SourceListItem,
} from '../src/infrastructure/guideline-source/guideline-source.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { FailingEmbeddingProvider } from './fixtures/failing-embedding.provider';
import { FakeGuidelineSource } from './fixtures/fake-guideline-source';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { FakePdfExtractor } from './fixtures/fake-pdf-extractor';
import {
  nckmGradeMissingPages,
  nckmSamplePages,
} from './fixtures/nckm-pages.sample';
import { socialSignUp, TestSession } from './fixtures/social-auth';
import {
  openSseStream,
  parseSseEvents,
  SseEvent,
  SseStream,
} from './fixtures/sse';

const CSRF = { 'X-CSRF-Protection': '1' };
const UNAUTHORIZED_MESSAGE = '인증이 필요합니다.';
const FORBIDDEN_MESSAGE = '권한이 없습니다.';
const NOT_FOUND_MESSAGE = '대상을 찾을 수 없습니다.';
const ALREADY_RUNNING_MESSAGE = '이미 실행 중인 지침 잡이 있습니다.';
const NOT_RUNNING_MESSAGE = '실행 중이 아닌 잡은 취소할 수 없습니다.';
const EMBEDDING_FAILED_MESSAGE = '지침 임베딩에 실패했습니다.';
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
  requestedBy: string;
  total: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

interface RunDto {
  id: string;
  jobId: string | null;
  order: number;
  sourceSystem: string | null;
  externalId: string | null;
  status: 'RUNNING' | 'SUCCEEDED' | 'SKIPPED' | 'FAILED' | 'INTERRUPTED';
  phase: 'ACQUIRE' | 'PARSE' | 'EMBED' | 'INGEST';
  errorCode: string | null;
  guidelineId: string | null;
  guidelineVersionId: string | null;
  revision: number | null;
  created: boolean | null;
  stages: Record<string, Record<string, unknown>>;
  startedAt: string;
  finishedAt: string | null;
}

interface JobDetailDto extends JobDto {
  runs: RunDto[];
}

interface JobStreamEvent extends SseEvent {
  job: JobDto;
  run?: RunDto;
  runs?: RunDto[];
}

describe('spec 22: 지침 전건 파이프라인', () => {
  jest.setTimeout(180_000);

  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication | undefined;
  let admin: TestSession;
  let member: TestSession;

  const fakeSource = new FakeGuidelineSource();
  const fakePdfExtractor = new FakePdfExtractor();
  const failingEmbedding = new FailingEmbeddingProvider();
  const mkdirMock = jest.mocked(mkdir);
  const writeFileMock = jest.mocked(writeFile);

  const currentApp = (): INestApplication => {
    if (!app) throw new Error('Nest 애플리케이션이 기동되지 않았습니다.');
    return app;
  };

  const createApplication = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(GUIDELINE_SOURCE)
      .useValue(fakeSource)
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(failingEmbedding)
      .overrideProvider(PdfTextExtractor)
      .useValue(fakePdfExtractor)
      .compile();

    const nextApp = moduleRef.createNestApplication();
    nextApp.setGlobalPrefix('api/v1');
    nextApp.use(cookieParser());
    await nextApp.listen(0);
    return nextApp;
  };

  const sourceItem = (externalId: string, title = `테스트 지침 ${externalId}`): SourceListItem => ({
    externalId,
    title,
    publisher: '대한테스트학회',
    releaseDate: '2024-07',
    sourceUrl: `https://example.test/guidelines/${externalId}`,
    fileName: `${externalId}.pdf`,
  });

  const addPdf = (
    externalId: string,
    pages: string[] = nckmSamplePages,
    title?: string,
  ): void => {
    const marker = `DOC:${externalId}`;
    fakeSource.addDocument(sourceItem(externalId, title), {
      body: Buffer.from(`%PDF-1.7\n${marker}\nfixture`),
      contentType: 'application/pdf',
    });
    fakePdfExtractor.setPagesFor(marker, pages);
  };

  const addHtml = (externalId: string): void => {
    fakeSource.addDocument(sourceItem(externalId), {
      body: Buffer.from(`<html><body>${externalId}: 첨부 없음</body></html>`),
      contentType: 'text/html',
    });
  };

  const expectEnvelopeBase = (body: Record<string, unknown>): void => {
    expect(body).toHaveProperty('success');
    expect(body).toHaveProperty('code');
    expect(body).toHaveProperty('message');
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('page');
    expect(body.timestamp).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(body.timestamp as string))).toBe(false);
    expect(body.traceId).toEqual(expect.any(String));
    expect((body.traceId as string).length).toBeGreaterThan(0);
  };

  const expectErrorEnvelope = (
    response: SupertestResponse,
    status: number,
    code: string,
    message: string,
  ): void => {
    expect(response.status).toBe(status);
    expectEnvelopeBase(response.body as Record<string, unknown>);
    expect(response.body).toMatchObject({
      success: false,
      code,
      message,
      data: null,
      page: null,
    });
  };

  const expectSuccessEnvelope = (
    response: SupertestResponse,
    status = 200,
  ): void => {
    expect(response.status).toBe(status);
    expectEnvelopeBase(response.body as Record<string, unknown>);
    expect(response.body.success).toBe(true);
    expect(response.body.code).toBe('SUCCESS');
  };

  const startJob = async (externalIds?: string[]): Promise<JobDto> => {
    const response = await request(currentApp().getHttpServer())
      .post('/api/v1/admin/guideline-jobs')
      .set(CSRF)
      .set('Cookie', admin.cookie)
      .send(externalIds === undefined ? {} : { externalIds });

    expectSuccessEnvelope(response, 202);
    expect(response.headers.location).toBeUndefined();
    const job = response.body.data as JobDto;
    expect(job).toMatchObject({
      status: 'RUNNING',
      requestedBy: admin.clinicianId,
      total: 0,
      processed: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      finishedAt: null,
      error: null,
    });
    expect(job.id).toEqual(expect.any(String));
    return job;
  };

  const getJob = async (jobId: string): Promise<JobDetailDto> => {
    const response = await request(currentApp().getHttpServer())
      .get(`/api/v1/admin/guideline-jobs/${jobId}`)
      .set('Cookie', admin.cookie);
    expectSuccessEnvelope(response);
    expect(response.body.page).toBeNull();
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
    timeoutMs = JOB_TIMEOUT_MS,
  ): Promise<JobDetailDto> => {
    const deadline = Date.now() + timeoutMs;
    let last: JobDetailDto | undefined;

    while (Date.now() < deadline) {
      last = await getJob(jobId);
      if (expectedStatuses.includes(last.status)) return last;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    throw new Error(
      `잡 ${jobId}가 ${timeoutMs}ms 안에 끝나지 않았습니다. 마지막 상태=${last?.status ?? '조회 전'}`,
    );
  };

  const callProtected = async (
    method: 'GET' | 'POST',
    path: string,
    cookie?: string,
  ): Promise<SupertestResponse> => {
    const client = request(currentApp().getHttpServer());
    const call =
      method === 'GET'
        ? client.get(path).set('Accept', path.endsWith('/stream') ? 'text/event-stream' : 'application/json')
        : client.post(path).set(CSRF).send({});
    if (cookie) call.set('Cookie', cookie);
    return call.timeout({ response: 5_000, deadline: 10_000 });
  };

  const asJobEvent = (event: SseEvent): JobStreamEvent =>
    event as JobStreamEvent;

  const expectCounters = (job: JobDto): void => {
    expect(job.total).toEqual(expect.any(Number));
    expect(job.processed).toEqual(expect.any(Number));
    expect(job.succeeded).toEqual(expect.any(Number));
    expect(job.skipped).toEqual(expect.any(Number));
    expect(job.failed).toEqual(expect.any(Number));
    expect(job.processed).toBe(job.succeeded + job.skipped + job.failed);
  };

  const listRuns = async (
    query: Record<string, string | number>,
  ): Promise<SupertestResponse> => {
    const response = await request(currentApp().getHttpServer())
      .get('/api/v1/admin/pipeline-runs')
      .query(query)
      .set('Cookie', admin.cookie);
    expectSuccessEnvelope(response);
    return response;
  };

  beforeAll(async () => {
    [container, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });
    app = await createApplication();

    admin = await socialSignUp(currentApp(), {
      email: 'guideline-bulk-admin@clinic.kr',
      providerId: 'guideline-bulk-admin',
    });
    member = await socialSignUp(currentApp(), {
      email: 'guideline-bulk-member@clinic.kr',
      providerId: 'guideline-bulk-member',
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
        ingestion_runs,
        source_documents
      CASCADE
    `);
    fakeSource.reset();
    fakePdfExtractor.reset();
    failingEmbedding.reset();
    mkdirMock.mockClear();
    writeFileMock.mockClear();
  });

  afterAll(async () => {
    fakeSource.resumeDownloads();
    await app?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  it('기준 1: 미인증은 401, MEMBER는 403이며 미존재 잡은 ADMIN에게 404다', async () => {
    const routes = [
      ['POST', '/api/v1/admin/guideline-jobs'],
      ['GET', '/api/v1/admin/guideline-jobs'],
      ['GET', '/api/v1/admin/guideline-jobs/missing-job'],
      ['GET', '/api/v1/admin/guideline-jobs/missing-job/stream'],
      ['POST', '/api/v1/admin/guideline-jobs/missing-job/cancel'],
      ['GET', '/api/v1/admin/pipeline-runs'],
    ] as const;

    // 401만으로 공허하게 통과하지 않도록 같은 it에서 모든 MEMBER 403을 함께 고정한다.
    const unauthenticated: SupertestResponse[] = [];
    const memberResponses: SupertestResponse[] = [];
    for (const [method, path] of routes) {
      unauthenticated.push(await callProtected(method, path));
      memberResponses.push(await callProtected(method, path, member.cookie));
    }

    for (const response of unauthenticated) {
      expectErrorEnvelope(response, 401, 'UNAUTHORIZED', UNAUTHORIZED_MESSAGE);
    }
    for (const response of memberResponses) {
      expectErrorEnvelope(response, 403, 'FORBIDDEN', FORBIDDEN_MESSAGE);
    }

    const missingDetail = await callProtected(
      'GET',
      '/api/v1/admin/guideline-jobs/missing-job',
      admin.cookie,
    );
    expectErrorEnvelope(missingDetail, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);

    // SSE는 헤더를 먼저 200으로 보내면 404 봉투를 만들 수 없다. 상태와 봉투를 함께 고정한다.
    const missingStream = await callProtected(
      'GET',
      '/api/v1/admin/guideline-jobs/missing-job/stream',
      admin.cookie,
    );
    expectErrorEnvelope(missingStream, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);

    const missingCancel = await callProtected(
      'POST',
      '/api/v1/admin/guideline-jobs/missing-job/cancel',
      admin.cookie,
    );
    expectErrorEnvelope(missingCancel, 404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
  });

  it('기준 2: POST는 202 RUNNING을 즉시 반환하고 전건 종료 후 실행·카운터를 남긴다', async () => {
    addPdf('bulk-success');
    addHtml('bulk-skipped');
    fakeSource.addItem(sourceItem('bulk-download-failed'));
    fakeSource.setFailure('bulk-download-failed');

    const created = await startJob();
    const completed = await waitForJob(created.id);

    expect(completed).toMatchObject({
      id: created.id,
      status: 'COMPLETED',
      total: 3,
      processed: 3,
      succeeded: 1,
      skipped: 1,
      failed: 1,
    });
    expect(completed.finishedAt).toEqual(expect.any(String));
    expect(completed.runs).toHaveLength(3);
    expect(completed.runs.map((run) => run.order)).toEqual(
      [...completed.runs.map((run) => run.order)].sort((a, b) => a - b),
    );
    for (const run of completed.runs) {
      expect(run.externalId).toEqual(expect.any(String));
      expect(run.status).toEqual(expect.any(String));
      expect(run.phase).toEqual(expect.any(String));
      expect(run.stages).toEqual(expect.any(Object));
    }

    const succeeded = completed.runs.find((run) => run.externalId === 'bulk-success');
    expect(succeeded).toMatchObject({
      status: 'SUCCEEDED',
      phase: 'INGEST',
      created: true,
      revision: 1,
    });
    expect(Object.keys(succeeded?.stages ?? {}).sort()).toEqual([
      'acquire',
      'embed',
      'ingest',
      'parse',
    ]);

    const skipped = completed.runs.find((run) => run.externalId === 'bulk-skipped');
    expect(skipped).toMatchObject({
      status: 'SKIPPED',
      phase: 'ACQUIRE',
    });
    expect(Object.keys(skipped?.stages ?? {})).toEqual(['acquire']);

    const downloadFailed = completed.runs.find(
      (run) => run.externalId === 'bulk-download-failed',
    );
    expect(downloadFailed).toMatchObject({
      status: 'FAILED',
      phase: 'ACQUIRE',
      errorCode: 'GUIDELINE_SOURCE_UNAVAILABLE',
    });
    expect(downloadFailed?.stages).toEqual({});
  });

  it('기준 3: 성공 실행은 ACTIVE revision과 임베딩 청크를 적재하고 PDF를 디스크에 쓰지 않는다', async () => {
    addPdf('persisted-guideline');

    const created = await startJob(['persisted-guideline']);
    const completed = await waitForJob(created.id);
    const run = completed.runs[0];

    expect(run).toMatchObject({
      externalId: 'persisted-guideline',
      status: 'SUCCEEDED',
      phase: 'INGEST',
      revision: 1,
      created: true,
    });
    expect(run.guidelineVersionId).toEqual(expect.any(String));

    const versions = await pool.query(
      `SELECT revision, status FROM guideline_versions WHERE id = $1`,
      [run.guidelineVersionId],
    );
    expect(versions.rows).toEqual([{ revision: 1, status: 'ACTIVE' }]);

    const chunks = await pool.query(
      `SELECT embedding FROM evidence_chunks WHERE guideline_version_id = $1 ORDER BY id`,
      [run.guidelineVersionId],
    );
    expect(chunks.rowCount).toBeGreaterThan(0);
    for (const chunk of chunks.rows) {
      expect(chunk.embedding).toBeTruthy();
    }

    expect(fakePdfExtractor.calls).toHaveLength(1);
    expect(fakePdfExtractor.allBuffered).toBe(true);
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('기준 4: 한 문서의 PARSE 실패가 나머지 문서의 적재와 잡 완료를 막지 않는다', async () => {
    addPdf('parse-ok-1');
    addPdf('parse-bad', nckmGradeMissingPages);
    addPdf('parse-ok-2');

    const created = await startJob(['parse-ok-1', 'parse-bad', 'parse-ok-2']);
    const completed = await waitForJob(created.id);

    expect(completed).toMatchObject({
      status: 'COMPLETED',
      total: 3,
      processed: 3,
      succeeded: 2,
      skipped: 0,
      failed: 1,
    });

    const failed = completed.runs.find((run) => run.externalId === 'parse-bad');
    expect(failed).toMatchObject({
      status: 'FAILED',
      phase: 'PARSE',
      errorCode: 'GUIDELINE_PARSE_FAILED',
      guidelineVersionId: null,
    });
    expect(Object.keys(failed?.stages ?? {})).toEqual(['acquire']);

    const successes = completed.runs.filter((run) => run.status === 'SUCCEEDED');
    expect(successes.map((run) => run.externalId).sort()).toEqual([
      'parse-ok-1',
      'parse-ok-2',
    ]);
    for (const run of successes) {
      const stored = await pool.query(
        `SELECT revision, status FROM guideline_versions WHERE id = $1`,
        [run.guidelineVersionId],
      );
      expect(stored.rows).toEqual([{ revision: 1, status: 'ACTIVE' }]);
    }
  });

  it('기준 5: EMBED 실패는 단계 산출과 코드가 PARSE 실패와 구분되고 단건 호출은 502다', async () => {
    const sharedTitle = '임베딩 실패 구분용 지침';
    addPdf('embedding-probe', nckmSamplePages, sharedTitle);
    addPdf('embedding-failure', nckmSamplePages, sharedTitle);

    // 실제 파서가 임베딩 경계로 보낸 텍스트에서 마커를 얻어 fixture의 실패 지점을 고정한다.
    const probe = await startJob(['embedding-probe']);
    await waitForJob(probe.id);
    const embeddedText = failingEmbedding.calls
      .flat()
      .find((text) => text.trim().length > 0);
    expect(embeddedText).toEqual(expect.any(String));
    failingEmbedding.failOn((embeddedText as string).slice(0, 64));

    const created = await startJob(['embedding-failure']);
    const completed = await waitForJob(created.id);
    const failed = completed.runs[0];

    expect(completed).toMatchObject({
      status: 'COMPLETED',
      total: 1,
      processed: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(failed).toMatchObject({
      externalId: 'embedding-failure',
      status: 'FAILED',
      phase: 'EMBED',
      errorCode: 'GUIDELINE_EMBEDDING_FAILED',
      guidelineVersionId: null,
    });
    expect(failed.stages.acquire).toEqual(expect.any(Object));
    expect(failed.stages.parse).toEqual(expect.any(Object));
    expect(failed.stages).not.toHaveProperty('embed');
    expect(failed.stages).not.toHaveProperty('ingest');

    const single = await request(currentApp().getHttpServer())
      .post('/api/v1/admin/guidelines/pipeline')
      .set(CSRF)
      .set('Cookie', admin.cookie)
      .send({ guideIdx: 'embedding-failure' });
    expectErrorEnvelope(
      single,
      502,
      'GUIDELINE_EMBEDDING_FAILED',
      EMBEDDING_FAILED_MESSAGE,
    );
  });

  it('기준 6: SSE는 스냅샷부터 단계별 누적 run을 보내고 job.completed 뒤 닫힌다', async () => {
    addPdf('stream-first');
    addPdf('stream-observed');
    fakeSource.pauseDownloads();

    let stream: SseStream | undefined;
    let jobId: string | undefined;
    try {
      const created = await startJob(['stream-first', 'stream-observed']);
      jobId = created.id;
      await fakeSource.waitForDownloads(1);

      stream = await openSseStream(
        `${await currentApp().getUrl()}/api/v1/admin/guideline-jobs/${created.id}/stream`,
        { cookie: admin.cookie, timeoutMs: 5_000 },
      );
      expect(stream.status).toBe(200);
      expect(stream.contentType).toContain('text/event-stream');
      const snapshot = asJobEvent(await stream.waitFor('job.snapshot'));
      expect(stream.events[0].eventType).toBe('job.snapshot');
      expect(snapshot.runs).toEqual(expect.any(Array));
      expect((snapshot.runs ?? []).length).toBeGreaterThan(0);
      expectCounters(snapshot.job);

      fakeSource.resumeDownloads();
      const events = await stream.untilClosed(JOB_TIMEOUT_MS);

      expect(events[0].eventType).toBe('job.snapshot');
      expect(events.at(-1)?.eventType).toBe('job.completed');
      expect(events.every((event) => !Object.hasOwn(event, 'seq'))).toBe(true);
      for (const event of events) {
        expect(asJobEvent(event).job).toEqual(expect.any(Object));
        expectCounters(asJobEvent(event).job);
      }

      const observedStages = events
        .filter((event) => event.eventType === 'run.stage')
        .map(asJobEvent)
        .filter((event) => event.run?.externalId === 'stream-observed')
        .map((event) => event.run as RunDto);

      expect(observedStages).toHaveLength(5);
      expect(observedStages.map((run) => run.phase)).toEqual([
        'ACQUIRE',
        'PARSE',
        'EMBED',
        'INGEST',
        'INGEST',
      ]);
      expect(observedStages.map((run) => run.status)).toEqual([
        'RUNNING',
        'RUNNING',
        'RUNNING',
        'RUNNING',
        'SUCCEEDED',
      ]);
      expect(observedStages.map((run) => Object.keys(run.stages).sort())).toEqual([
        [],
        ['acquire'],
        ['acquire', 'parse'],
        ['acquire', 'embed', 'parse'],
        ['acquire', 'embed', 'ingest', 'parse'],
      ]);

      const terminal = asJobEvent(events.at(-1) as SseEvent);
      expect(terminal.job).toMatchObject({
        id: created.id,
        status: 'COMPLETED',
        total: 2,
        processed: 2,
        succeeded: 2,
      });
    } finally {
      stream?.close();
      fakeSource.resumeDownloads();
      if (jobId) {
        await waitForJob(jobId).catch(() => undefined);
      }
    }
  });

  it('기준 7: 끝난 잡은 즉시 snapshot+completed로 닫히고 늦은 연결은 runs로 복구한다', async () => {
    addPdf('finished-stream-1');
    addPdf('finished-stream-2');
    const finishedJob = await startJob(['finished-stream-1', 'finished-stream-2']);
    const finishedDetail = await waitForJob(finishedJob.id);

    const finishedResponse = await request(currentApp().getHttpServer())
      .get(`/api/v1/admin/guideline-jobs/${finishedJob.id}/stream`)
      .set('Accept', 'text/event-stream')
      .set('Cookie', admin.cookie)
      .timeout({ response: 5_000, deadline: 10_000 });
    expect(finishedResponse.status).toBe(200);
    expect(finishedResponse.headers['content-type']).toContain('text/event-stream');
    const finishedEvents = parseSseEvents(finishedResponse.text).map(asJobEvent);
    expect(finishedEvents.map((event) => event.eventType)).toEqual([
      'job.snapshot',
      'job.completed',
    ]);
    expect(finishedEvents[0].runs?.map((run) => run.id)).toEqual(
      finishedDetail.runs.map((run) => run.id),
    );
    expect(finishedEvents[0].runs?.map((run) => run.order)).toEqual(
      [...(finishedEvents[0].runs ?? []).map((run) => run.order)].sort((a, b) => a - b),
    );
    expect(finishedEvents[1].job.status).toBe('COMPLETED');

    fakeSource.reset();
    fakePdfExtractor.reset();
    addPdf('late-stream-1');
    addPdf('late-stream-2');
    fakeSource.pauseDownloads();

    let lateStream: SseStream | undefined;
    let lateJobId: string | undefined;
    try {
      const lateJob = await startJob(['late-stream-1', 'late-stream-2']);
      lateJobId = lateJob.id;
      await fakeSource.waitForDownloads(1);

      lateStream = await openSseStream(
        `${await currentApp().getUrl()}/api/v1/admin/guideline-jobs/${lateJob.id}/stream`,
        { cookie: admin.cookie },
      );
      const snapshot = asJobEvent(await lateStream.waitFor('job.snapshot'));
      const storedRuns = await pool.query(
        `SELECT id FROM pipeline_runs WHERE job_id = $1 ORDER BY "order" ASC`,
        [lateJob.id],
      );
      expect(storedRuns.rowCount).toBeGreaterThan(0);
      expect(snapshot.runs?.map((run) => run.id)).toEqual(
        storedRuns.rows.map((row) => row.id as string),
      );
      expect(snapshot.runs?.[0]).toMatchObject({
        externalId: 'late-stream-1',
        status: 'RUNNING',
        phase: 'ACQUIRE',
      });
      expect(snapshot.runs?.[0].stages).toEqual({});
    } finally {
      lateStream?.close();
      fakeSource.resumeDownloads();
      if (lateJobId) {
        const completed = await waitForJob(lateJobId).catch(() => undefined);
        if (completed) expect(completed.status).toBe('COMPLETED');
      }
    }
  });

  it('기준 8: 활성 잡 중 두 번째 POST는 409이고 새 잡 행을 만들지 않는다', async () => {
    addPdf('concurrent-job');
    fakeSource.pauseDownloads();

    let activeJobId: string | undefined;
    try {
      const active = await startJob(['concurrent-job']);
      activeJobId = active.id;
      await fakeSource.waitForDownloads(1);

      const before = await pool.query(`SELECT count(*)::int AS count FROM guideline_jobs`);
      const duplicate = await request(currentApp().getHttpServer())
        .post('/api/v1/admin/guideline-jobs')
        .set(CSRF)
        .set('Cookie', admin.cookie)
        .send({ externalIds: ['concurrent-job'] });
      expectErrorEnvelope(
        duplicate,
        409,
        'GUIDELINE_JOB_ALREADY_RUNNING',
        ALREADY_RUNNING_MESSAGE,
      );
      const after = await pool.query(`SELECT count(*)::int AS count FROM guideline_jobs`);
      expect(after.rows[0].count).toBe(before.rows[0].count);
      expect(after.rows[0].count).toBe(1);
    } finally {
      fakeSource.resumeDownloads();
      if (activeJobId) await waitForJob(activeJobId).catch(() => undefined);
    }
  });

  it('기준 9: cancel은 문서 경계에서 멈추고 재호출은 멱등이며 종결 잡 취소는 409다', async () => {
    addPdf('cancel-current');
    addPdf('cancel-remaining-1');
    addPdf('cancel-remaining-2');
    fakeSource.pauseDownloads();

    let jobId: string | undefined;
    try {
      const created = await startJob([
        'cancel-current',
        'cancel-remaining-1',
        'cancel-remaining-2',
      ]);
      jobId = created.id;
      await fakeSource.waitForDownloads(1);

      const cancel = await request(currentApp().getHttpServer())
        .post(`/api/v1/admin/guideline-jobs/${created.id}/cancel`)
        .set(CSRF)
        .set('Cookie', admin.cookie)
        .send({});
      expectSuccessEnvelope(cancel);
      expect(cancel.body.data).toMatchObject({
        id: created.id,
        status: 'CANCELLING',
      });

      const repeated = await request(currentApp().getHttpServer())
        .post(`/api/v1/admin/guideline-jobs/${created.id}/cancel`)
        .set(CSRF)
        .set('Cookie', admin.cookie)
        .send({});
      expectSuccessEnvelope(repeated);
      expect(repeated.body.data).toMatchObject({
        id: created.id,
        status: 'CANCELLING',
      });

      fakeSource.resumeDownloads();
      const cancelled = await waitForJob(created.id, ['CANCELLED']);
      expect(cancelled).toMatchObject({
        status: 'CANCELLED',
        total: 3,
        processed: 1,
        succeeded: 1,
        skipped: 0,
        failed: 0,
      });
      expect(cancelled.runs).toHaveLength(1);
      expect(cancelled.runs[0]).toMatchObject({
        externalId: 'cancel-current',
        status: 'SUCCEEDED',
      });
      expect(fakeSource.downloadLog).toEqual(['cancel-current']);

      const rows = await pool.query(
        `SELECT external_id FROM pipeline_runs WHERE job_id = $1 ORDER BY "order"`,
        [created.id],
      );
      expect(rows.rows.map((row) => row.external_id)).toEqual(['cancel-current']);

      const terminalCancel = await request(currentApp().getHttpServer())
        .post(`/api/v1/admin/guideline-jobs/${created.id}/cancel`)
        .set(CSRF)
        .set('Cookie', admin.cookie)
        .send({});
      expectErrorEnvelope(
        terminalCancel,
        409,
        'GUIDELINE_JOB_NOT_RUNNING',
        NOT_RUNNING_MESSAGE,
      );
    } finally {
      fakeSource.resumeDownloads();
      if (jobId) await waitForJob(jobId).catch(() => undefined);
    }
  });

  it('기준 10: externalIds만 처리하며 목록에 없는 id도 ACQUIRE NOT_FOUND 실행으로 집계한다', async () => {
    addPdf('target-guideline');
    addPdf('untargeted-guideline');
    const requested = ['target-guideline', 'not-in-source-list'];

    const created = await startJob(requested);
    const completed = await waitForJob(created.id);

    expect(completed).toMatchObject({
      status: 'COMPLETED',
      total: 2,
      processed: 2,
      succeeded: 1,
      skipped: 0,
      failed: 1,
    });
    expect(fakeSource.listCalls).toContainEqual({ externalIds: requested });
    expect(fakeSource.downloadLog).toEqual(['target-guideline']);
    expect(completed.runs).toHaveLength(2);
    expect(completed.runs.map((run) => run.externalId).sort()).toEqual(
      [...requested].sort(),
    );

    const found = completed.runs.find((run) => run.externalId === 'target-guideline');
    expect(found).toMatchObject({
      status: 'SUCCEEDED',
      phase: 'INGEST',
    });
    const missing = completed.runs.find((run) => run.externalId === 'not-in-source-list');
    expect(missing).toMatchObject({
      status: 'FAILED',
      phase: 'ACQUIRE',
      errorCode: 'NOT_FOUND',
      guidelineVersionId: null,
    });
    expect(missing?.stages).toEqual({});
  });

  it('기준 11: 재기동은 활성 잡과 실행을 INTERRUPTED로 정리하고 phase를 보존한다', async () => {
    const interruptedJobId = 'job-running-before-restart';
    const interruptedRunId = 'run-running-before-restart';
    await pool.query(
      `
        INSERT INTO guideline_jobs
          (id, status, requested_by, total, processed, succeeded, skipped, failed)
        VALUES ($1, 'RUNNING', $2, 3, 0, 0, 0, 0)
      `,
      [interruptedJobId, admin.clinicianId],
    );
    await pool.query(
      `
        INSERT INTO pipeline_runs
          (id, job_id, "order", source_system, external_id, status, phase, stages)
        VALUES ($1, $2, 0, 'NCKM', 'restart-324', 'RUNNING', 'EMBED', $3::jsonb)
      `,
      [
        interruptedRunId,
        interruptedJobId,
        JSON.stringify({
          acquire: { bytes: 128, contentType: 'application/pdf', ms: 4 },
          parse: { pages: 10, sections: 2, chunks: 3, ms: 8 },
        }),
      ],
    );

    addPdf('after-restart');
    const previousApp = currentApp();
    try {
      app = undefined;
      await previousApp.close();
      app = await createApplication();

      const jobs = await pool.query(
        `SELECT status FROM guideline_jobs WHERE id = $1`,
        [interruptedJobId],
      );
      expect(jobs.rows).toEqual([{ status: 'INTERRUPTED' }]);

      const runs = await pool.query(
        `SELECT status, phase, stages FROM pipeline_runs WHERE id = $1`,
        [interruptedRunId],
      );
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0]).toMatchObject({
        status: 'INTERRUPTED',
        phase: 'EMBED',
      });
      expect(runs.rows[0].stages).toEqual({
        acquire: { bytes: 128, contentType: 'application/pdf', ms: 4 },
        parse: { pages: 10, sections: 2, chunks: 3, ms: 8 },
      });

      const fresh = await startJob(['after-restart']);
      const completed = await waitForJob(fresh.id);
      expect(completed.status).toBe('COMPLETED');
    } finally {
      fakeSource.resumeDownloads();
      if (!app) app = await createApplication();
    }
  });

  it('기준 12: 같은 대상 재적재는 SUCCEEDED created=false이고 revision을 올리지 않는다', async () => {
    addPdf('idempotent-guideline');

    const firstJob = await startJob(['idempotent-guideline']);
    const first = await waitForJob(firstJob.id);
    expect(first.runs[0]).toMatchObject({
      status: 'SUCCEEDED',
      phase: 'INGEST',
      created: true,
      revision: 1,
    });
    const firstVersionId = first.runs[0].guidelineVersionId;

    const secondJob = await startJob(['idempotent-guideline']);
    const second = await waitForJob(secondJob.id);
    expect(second.runs[0]).toMatchObject({
      status: 'SUCCEEDED',
      phase: 'INGEST',
      created: false,
      revision: 1,
      guidelineVersionId: firstVersionId,
    });
    expect(Object.keys(second.runs[0].stages).sort()).toEqual([
      'acquire',
      'ingest',
      'parse',
    ]);
    expect(second.runs[0].stages).not.toHaveProperty('embed');

    const versions = await pool.query(
      `
        SELECT id, revision, status
        FROM guideline_versions
        WHERE guideline_id = $1
        ORDER BY revision
      `,
      [second.runs[0].guidelineId],
    );
    expect(versions.rows).toEqual([
      { id: firstVersionId, revision: 1, status: 'ACTIVE' },
    ]);
  });

  it('기준 13: 실행 목록은 단건 실행·필터·최신순 불투명 커서를 모두 지원한다', async () => {
    addPdf('history-shared');
    addPdf('history-parse-failed', nckmGradeMissingPages);

    const standalone = await request(currentApp().getHttpServer())
      .post('/api/v1/admin/guidelines/pipeline')
      .set(CSRF)
      .set('Cookie', admin.cookie)
      .send({ guideIdx: 'history-shared' });
    expect(standalone.status).toBeGreaterThanOrEqual(200);
    expect(standalone.status).toBeLessThan(300);
    expectSuccessEnvelope(standalone, standalone.status);

    const job = await startJob(['history-shared', 'history-parse-failed']);
    const completed = await waitForJob(job.id);
    expect(completed.runs).toHaveLength(2);

    const byJob = await listRuns({ jobId: job.id, size: 20 });
    const byJobRuns = byJob.body.data as RunDto[];
    expect(byJobRuns).toHaveLength(2);
    expect(byJobRuns.every((run) => run.jobId === job.id)).toBe(true);
    expect(byJobRuns.map((run) => run.id)).toEqual(
      [...byJobRuns.map((run) => run.id)].sort().reverse(),
    );

    const byExternalId = await listRuns({
      externalId: 'history-shared',
      size: 20,
    });
    const sharedRuns = byExternalId.body.data as RunDto[];
    expect(sharedRuns).toHaveLength(2);
    expect(sharedRuns.every((run) => run.externalId === 'history-shared')).toBe(true);
    expect(sharedRuns.some((run) => run.jobId === null)).toBe(true);
    expect(sharedRuns.some((run) => run.jobId === job.id)).toBe(true);

    const byStatus = await listRuns({ status: 'FAILED', size: 20 });
    const failedRuns = byStatus.body.data as RunDto[];
    expect(failedRuns).toHaveLength(1);
    expect(failedRuns[0]).toMatchObject({
      externalId: 'history-parse-failed',
      status: 'FAILED',
    });

    const byPhase = await listRuns({ phase: 'PARSE', size: 20 });
    const parseRuns = byPhase.body.data as RunDto[];
    expect(parseRuns).toHaveLength(1);
    expect(parseRuns[0]).toMatchObject({
      externalId: 'history-parse-failed',
      phase: 'PARSE',
    });

    const expectedOrder = await pool.query(`SELECT id FROM pipeline_runs ORDER BY id DESC`);
    expect(expectedOrder.rows).toHaveLength(3);
    const firstPage = await listRuns({ size: 2 });
    expect((firstPage.body.data as RunDto[]).map((run) => run.id)).toEqual(
      expectedOrder.rows.slice(0, 2).map((row) => row.id as string),
    );
    expect(firstPage.body.page).toMatchObject({
      size: 2,
      hasNext: true,
    });
    expect(firstPage.body.page.nextCursor).toEqual(expect.any(String));
    expect(firstPage.body.page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(firstPage.body.page.nextCursor).not.toContain(
      (firstPage.body.data as RunDto[])[1].id,
    );

    const secondPage = await listRuns({
      size: 2,
      cursor: firstPage.body.page.nextCursor as string,
    });
    expect((secondPage.body.data as RunDto[]).map((run) => run.id)).toEqual(
      expectedOrder.rows.slice(2).map((row) => row.id as string),
    );
    expect(secondPage.body.page).toEqual({
      size: 2,
      hasNext: false,
      nextCursor: null,
    });
  });

  it('기준 14: 잡 목록은 최신순이며 불투명 커서로 중복 없이 페이지네이션한다', async () => {
    addPdf('job-history');
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await startJob(['job-history']);
      await waitForJob(created.id);
      ids.push(created.id);
    }
    const expectedOrder = [...ids].sort().reverse();

    const firstPage = await request(currentApp().getHttpServer())
      .get('/api/v1/admin/guideline-jobs')
      .query({ size: 2 })
      .set('Cookie', admin.cookie);
    expectSuccessEnvelope(firstPage);
    expect((firstPage.body.data as JobDto[]).map((job) => job.id)).toEqual([
      expectedOrder[0],
      expectedOrder[1],
    ]);
    expect(firstPage.body.page).toMatchObject({
      size: 2,
      hasNext: true,
    });
    expect(firstPage.body.page.nextCursor).toEqual(expect.any(String));
    expect(firstPage.body.page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(firstPage.body.page.nextCursor).not.toContain(expectedOrder[1]);

    const secondPage = await request(currentApp().getHttpServer())
      .get('/api/v1/admin/guideline-jobs')
      .query({ size: 2, cursor: firstPage.body.page.nextCursor })
      .set('Cookie', admin.cookie);
    expectSuccessEnvelope(secondPage);
    expect((secondPage.body.data as JobDto[]).map((job) => job.id)).toEqual([ids[0]]);
    expect(secondPage.body.page).toEqual({
      size: 2,
      hasNext: false,
      nextCursor: null,
    });

    const allIds = [
      ...(firstPage.body.data as JobDto[]).map((job) => job.id),
      ...(secondPage.body.data as JobDto[]).map((job) => job.id),
    ];
    expect(new Set(allIds).size).toBe(3);
    expect(allIds).toEqual(expectedOrder);
  });
});
