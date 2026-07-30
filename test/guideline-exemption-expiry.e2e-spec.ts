/**
 * docs/specs/25 수용 기준 5·6·7·8·9·10·17·18.
 *
 * 합성 PDF 본문과 추출 페이지만 사용한다. 목록은 GuidelineListProvider로 주입하고,
 * 같은 본문 버퍼의 sha256을 항목과 현재 문서 identity에 결합한다.
 */
import { createHash } from 'node:crypto';
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
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GuidelineListProvider } from '../src/domain/guideline/service/guideline-list.provider';
import { type KnownSourceDefect } from '../src/domain/guideline/service/known-source-defects';
import { type NotIngestTarget } from '../src/domain/guideline/service/not-ingest-targets';
import {
  type AlertEvent,
  RealTimeAlertSender,
} from '../src/global/observability/real-time-alert.sender';
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
  expiredKnownDefectPages,
  expiryNoMarkerPages,
} from './fixtures/nckm-expiry-samples';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { FakePdfExtractor } from './fixtures/fake-pdf-extractor';
import { socialSignUp, type TestSession } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const JOB_TIMEOUT_MS = 30_000;
const CURRENT_VERSION = '2026-07';
const RECORDED_VERSION = '2026-06';
const EXPIRY_PATTERN = /만료|expired/i;
const NOT_INGEST_LIST_PATTERN =
  /대상\s*아님|제외\s*목록|NOT[_\s-]?INGEST[_\s-]?TARGETS?/i;
const SOURCE_DEFECT_LIST_PATTERN =
  /원문\s*결함|결함\s*면제|면제\s*목록|KNOWN[_\s-]?SOURCE[_\s-]?DEFECTS?/i;

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

interface AddedDocument {
  externalId: string;
  version: string;
  body: Buffer;
  fileHash: string;
}

interface TargetRunResult {
  completed: JobDetailDto;
  run: RunDto;
  document: AddedDocument;
  listed: NotIngestTarget;
}

interface DefectRunResult {
  completed: JobDetailDto;
  run: RunDto;
  document: AddedDocument;
  listed: KnownSourceDefect;
}

class FakeGuidelineListProvider {
  private defects: KnownSourceDefect[] = [];
  private targets: NotIngestTarget[] = [];

  setKnownSourceDefects(defects: KnownSourceDefect[]): this {
    this.defects = defects.map((entry) => ({
      ...entry,
      numbers: [...entry.numbers],
    }));
    return this;
  }

  setNotIngestTargets(targets: NotIngestTarget[]): this {
    this.targets = targets.map((entry) => ({ ...entry }));
    return this;
  }

  knownSourceDefects(): KnownSourceDefect[] {
    return this.defects.map((entry) => ({
      ...entry,
      numbers: [...entry.numbers],
    }));
  }

  notIngestTargets(): NotIngestTarget[] {
    return this.targets.map((entry) => ({ ...entry }));
  }

  reset(): this {
    this.defects = [];
    this.targets = [];
    return this;
  }
}

describe('spec 25: 면제·제외 목록 만료 진단과 통보', () => {
  jest.setTimeout(180_000);

  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication | undefined;
  let admin: TestSession;

  const fakeSource = new FakeGuidelineSource();
  const fakePdfExtractor = new FakePdfExtractor();
  const failingEmbedding = new FailingEmbeddingProvider();
  const listProvider = new FakeGuidelineListProvider();
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

  const sha256 = (body: Buffer): string =>
    createHash('sha256').update(body).digest('hex');

  const differentHash = (fileHash: string): string =>
    `${fileHash.startsWith('0') ? '1' : '0'}${fileHash.slice(1)}`;

  const sourceItem = (
    externalId: string,
    version = CURRENT_VERSION,
  ): SourceListItem => ({
    externalId,
    title: `합성 만료 테스트 지침 ${externalId}`,
    publisher: '가상별빛학회',
    releaseDate: version,
    sourceUrl: `https://example.test/guidelines/${externalId}`,
    fileName: `${externalId}.pdf`,
  });

  const addPdf = (
    externalId: string,
    pages: string[],
    version = CURRENT_VERSION,
  ): AddedDocument => {
    const marker = `DOC:${externalId}`;
    const body = Buffer.from(
      `%PDF-1.7\n${marker}\nsynthetic exemption expiry fixture`,
    );
    fakeSource.addDocument(sourceItem(externalId, version), {
      // 해시를 낸 바로 그 버퍼를 fake 원본과 fake 추출기의 식별 본문으로 함께 쓴다.
      body,
      contentType: 'application/pdf',
    });
    fakePdfExtractor.setPagesFor(marker, pages);
    return {
      externalId,
      version,
      body,
      fileHash: sha256(body),
    };
  };

  const targetFor = (
    document: AddedDocument,
    overrides: Partial<NotIngestTarget> = {},
  ): NotIngestTarget => ({
    sourceSystem: fakeSource.system,
    externalId: document.externalId,
    version: document.version,
    fileHash: document.fileHash,
    reason: `합성 대상 아님 사유 ${document.externalId}`,
    ...overrides,
  });

  const defectFor = (
    document: AddedDocument,
    overrides: Partial<KnownSourceDefect> = {},
  ): KnownSourceDefect => ({
    sourceSystem: fakeSource.system,
    externalId: document.externalId,
    version: document.version,
    fileHash: document.fileHash,
    diagnostic: 'duplicated',
    numbers: ['R20'],
    reason: `합성 원문 R20 중복 사유 ${document.externalId}`,
    ...overrides,
  });

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

  const requiredError = (run: RunDto): string => {
    expect(run.error).toEqual(expect.any(String));
    if (!run.error) {
      throw new Error(`실행 ${run.externalId ?? 'unknown'}에 error가 없습니다.`);
    }
    return run.error;
  };

  const requiredAlert = (): AlertEvent => {
    const event = sendAlert.mock.calls[0]?.[0];
    expect(event).toBeDefined();
    if (!event) throw new Error('만료 알림 호출을 찾지 못했습니다.');
    return event;
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
    await clearPersistence();
    fakeSource.reset();
    fakePdfExtractor.reset();
    failingEmbedding.reset();
    listProvider.reset();
    sendAlert.mockReset();
    sendAlert.mockImplementation((event: AlertEvent): void => {
      void event;
    });
  };

  const runExpiredTarget = async (
    externalId: string,
    axis: 'version' | 'fileHash',
  ): Promise<TargetRunResult> => {
    const document = addPdf(externalId, expiryNoMarkerPages);
    const listed = targetFor(
      document,
      axis === 'version'
        ? { version: RECORDED_VERSION }
        : { fileHash: differentHash(document.fileHash) },
    );
    listProvider.setNotIngestTargets([listed]);

    const created = await startJob();
    const completed = await waitForJob(created.id);
    return {
      completed,
      run: runFor(completed, externalId),
      document,
      listed,
    };
  };

  const runExactTarget = async (
    externalId: string,
  ): Promise<TargetRunResult> => {
    const document = addPdf(externalId, expiryNoMarkerPages);
    const listed = targetFor(document);
    listProvider.setNotIngestTargets([listed]);

    const created = await startJob();
    const completed = await waitForJob(created.id);
    return {
      completed,
      run: runFor(completed, externalId),
      document,
      listed,
    };
  };

  const runUnlisted = async (
    externalId: string,
  ): Promise<{
    completed: JobDetailDto;
    run: RunDto;
    document: AddedDocument;
  }> => {
    const document = addPdf(externalId, expiryNoMarkerPages);

    const created = await startJob();
    const completed = await waitForJob(created.id);
    return {
      completed,
      run: runFor(completed, externalId),
      document,
    };
  };

  const runExpiredDefect = async (
    externalId: string,
    axis: 'version' | 'fileHash',
  ): Promise<DefectRunResult> => {
    const document = addPdf(externalId, expiredKnownDefectPages);
    const listed = defectFor(
      document,
      axis === 'version'
        ? { version: RECORDED_VERSION }
        : { fileHash: differentHash(document.fileHash) },
    );
    listProvider.setKnownSourceDefects([listed]);

    const created = await startJob();
    const completed = await waitForJob(created.id);
    return {
      completed,
      run: runFor(completed, externalId),
      document,
      listed,
    };
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
      .useValue(listProvider)
      .overrideProvider(RealTimeAlertSender)
      .useValue(fakeAlertSender)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.listen(0);

    admin = await socialSignUp(currentApp(), {
      email: 'guideline-exemption-expiry-admin@clinic.kr',
      providerId: 'guideline-exemption-expiry-admin',
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
    await app?.close();
    await pool?.end();
    await postgresContainer?.stop();
    await redisContainer?.stop();
  });

  it('기준 5a: 목록 항목이 만료된 마커 부재 실패는 목록에 없다는 거짓 안내를 남기지 않는다', async () => {
    const { run, listed } = await runExpiredTarget(
      'expired-listed-diagnostic',
      'version',
    );

    expect(run).toMatchObject({
      status: 'FAILED',
      phase: 'PARSE',
      errorCode: 'GUIDELINE_PARSE_FAILED',
    });
    const error = requiredError(run);
    expect(error).toMatch(EXPIRY_PATTERN);
    expect(error).toMatch(NOT_INGEST_LIST_PATTERN);
    expect(error).toContain(listed.externalId);
    expect(error).not.toContain('목록에도 없습니다');
  });

  it('기준 5b: 마커 부재 실패 error에 만료 축의 기록값과 현재값을 함께 남긴다', async () => {
    const { run, document, listed } = await runExpiredTarget(
      'expired-axis-values',
      'version',
    );

    const error = requiredError(run);
    expect(error).toMatch(EXPIRY_PATTERN);
    expect(error).toContain('version');
    expect(error).toContain(listed.version);
    expect(error).toContain(document.version);
    expect(listed.version).not.toBe(document.version);
  });

  it('기준 6a: 결함 면제가 만료되어 §20 가드가 실패하면 detail에 만료 후보를 담는다', async () => {
    const { run, document, listed } = await runExpiredDefect(
      'expired-known-source-defect',
      'fileHash',
    );

    expect(run).toMatchObject({
      status: 'FAILED',
      phase: 'PARSE',
      errorCode: 'GUIDELINE_PARSE_FAILED',
    });
    const error = requiredError(run);
    expect(error).toMatch(EXPIRY_PATTERN);
    expect(error).toMatch(SOURCE_DEFECT_LIST_PATTERN);
    expect(error).toContain('fileHash');
    expect(error).toContain(listed.fileHash);
    expect(error).toContain(document.fileHash);
    expect(error).toContain('R20');
  });

  it('기준 7a: 만료 후보가 없는 마커 부재 실패에는 만료 서술이 들어가지 않는다', async () => {
    // 일반 실패만 관찰해 알림·진단이 전혀 배선되지 않은 스텁이 통과하지 않도록 양성 대조한다.
    const control = await runExpiredTarget(
      'expiry-diagnostic-positive-control',
      'version',
    );
    expect(requiredError(control.run)).toMatch(EXPIRY_PATTERN);

    await resetScenario();
    const { run } = await runUnlisted('ordinary-unlisted-no-marker');

    expect(run).toMatchObject({
      status: 'FAILED',
      phase: 'PARSE',
      errorCode: 'GUIDELINE_PARSE_FAILED',
    });
    const error = requiredError(run);
    expect(error).not.toMatch(EXPIRY_PATTERN);
    expect(error).toContain('목록에도 없습니다');
  });

  it('기준 8a: 만료 후보가 판별되면 RealTimeAlertSender.send를 호출한다', async () => {
    await runExpiredTarget('expired-alert-call', 'fileHash');

    expect(sendAlert).toHaveBeenCalled();

    await resetScenario();
    await runExpiredDefect('expired-defect-alert-call', 'version');

    expect(sendAlert).toHaveBeenCalled();
  });

  it('기준 8b: 만료 알림 title에 목록 종류와 문서 식별자를 담는다', async () => {
    const { document } = await runExpiredTarget(
      'expired-alert-title',
      'fileHash',
    );

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const event = requiredAlert();
    expect(event.title).toMatch(NOT_INGEST_LIST_PATTERN);
    expect(event.title).toContain(document.externalId);

    await resetScenario();
    const defect = await runExpiredDefect(
      'expired-defect-alert-title',
      'version',
    );

    expect(sendAlert).toHaveBeenCalled();
    const defectEvent = requiredAlert();
    expect(defectEvent.title).toMatch(SOURCE_DEFECT_LIST_PATTERN);
    expect(defectEvent.title).toContain(defect.document.externalId);
  });

  it('기준 8c: 만료 알림 detail에 만료 축과 목록 항목 reason을 담는다', async () => {
    const { listed } = await runExpiredTarget(
      'expired-alert-detail',
      'fileHash',
    );

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const detail = requiredAlert().detail;
    expect(detail).toEqual(expect.any(String));
    expect(detail).toContain('fileHash');
    expect(detail).toContain(listed.reason);

    await resetScenario();
    const defect = await runExpiredDefect(
      'expired-defect-alert-detail',
      'version',
    );

    expect(sendAlert).toHaveBeenCalled();
    const defectDetail = requiredAlert().detail;
    expect(defectDetail).toEqual(expect.any(String));
    expect(defectDetail).toContain('version');
    expect(defectDetail).toContain(defect.listed.reason);
  });

  it('기준 9a: 알림 sender가 예외를 던져도 파이프라인 실행 결과는 정상 종결한다', async () => {
    sendAlert.mockImplementation(() => {
      throw new Error('synthetic alert channel failure');
    });

    const { completed, run } = await runExpiredTarget(
      'expired-alert-throws',
      'fileHash',
    );

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({
      status: 'FAILED',
      phase: 'PARSE',
      errorCode: 'GUIDELINE_PARSE_FAILED',
    });
    expect(requiredError(run)).toMatch(EXPIRY_PATTERN);
    expect(completed).toMatchObject({
      status: 'COMPLETED',
      total: 1,
      processed: 1,
      succeeded: 0,
      skipped: 0,
      failed: 1,
    });

    await resetScenario();
    sendAlert.mockImplementation(() => {
      throw new Error('synthetic defect alert channel failure');
    });
    const defect = await runExpiredDefect(
      'expired-defect-alert-throws',
      'version',
    );

    expect(sendAlert).toHaveBeenCalled();
    expect(defect.run).toMatchObject({
      status: 'FAILED',
      phase: 'PARSE',
      errorCode: 'GUIDELINE_PARSE_FAILED',
    });
    expect(requiredError(defect.run)).toMatch(EXPIRY_PATTERN);
    expect(defect.completed).toMatchObject({
      status: 'COMPLETED',
      total: 1,
      processed: 1,
      succeeded: 0,
      skipped: 0,
      failed: 1,
    });
  });

  it('기준 10a: 만료 후보가 없는 일반 실패에서는 send를 호출하지 않는다', async () => {
    // sender 자체가 실제 만료 경로에 연결되었다는 양성 대조 뒤 호출 기록을 비운다.
    await runExpiredTarget('expiry-alert-positive-control', 'version');
    expect(sendAlert).toHaveBeenCalledTimes(1);

    await resetScenario();
    const { run } = await runUnlisted('ordinary-failure-without-alert');

    expect(run).toMatchObject({
      status: 'FAILED',
      phase: 'PARSE',
      errorCode: 'GUIDELINE_PARSE_FAILED',
    });
    expect(requiredError(run)).not.toMatch(EXPIRY_PATTERN);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('기준 17a: version 일치·fileHash 불일치 문서는 FAILED로 종결한다', async () => {
    const { run, document, listed } = await runExpiredTarget(
      'e2e-hash-mismatch-failed',
      'fileHash',
    );

    expect(listed.version).toBe(document.version);
    expect(listed.fileHash).not.toBe(document.fileHash);
    expect(run).toMatchObject({
      status: 'FAILED',
      phase: 'PARSE',
      errorCode: 'GUIDELINE_PARSE_FAILED',
    });
    // 일반 미등재 실패가 기준 17a를 대신 통과하지 못하게 실패 원인도 해시 축에 묶는다.
    expect(requiredError(run)).toContain('fileHash');
  });

  it('기준 17b: fileHash 불일치 실행 error에 만료를 명시한다', async () => {
    const { run, document, listed } = await runExpiredTarget(
      'e2e-hash-mismatch-detail',
      'fileHash',
    );

    const error = requiredError(run);
    expect(error).toMatch(EXPIRY_PATTERN);
    expect(error).toContain('fileHash');
    expect(error).toContain(listed.fileHash);
    expect(error).toContain(document.fileHash);
    expect(error).not.toContain('목록에도 없습니다');
  });

  it('기준 17c: fileHash 불일치 실행에서 알림이 정확히 1건 나간다', async () => {
    await runExpiredTarget('e2e-hash-mismatch-one-alert', 'fileHash');

    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it('기준 18a: 네 축이 모두 일치하는 문서는 SKIPPED/PARSE로 종결한다', async () => {
    const exact = await runExactTarget('e2e-four-axis-match-skipped');

    expect(exact.listed).toMatchObject({
      sourceSystem: fakeSource.system,
      externalId: exact.document.externalId,
      version: exact.document.version,
      fileHash: exact.document.fileHash,
    });
    expect(exact.run).toMatchObject({
      status: 'SKIPPED',
      phase: 'PARSE',
      errorCode: null,
      error: null,
    });
    expect(exact.completed).toMatchObject({
      total: 1,
      processed: 1,
      succeeded: 0,
      skipped: 1,
      failed: 0,
    });

    // 기존 3축 일치 경로만 구현된 상태도 이 테스트를 통과하지 못하게 해시 만료를 대조한다.
    await resetScenario();
    const expired = await runExpiredTarget(
      'e2e-four-axis-expiry-control',
      'fileHash',
    );
    expect(requiredError(expired.run)).toMatch(EXPIRY_PATTERN);
  });

  it('기준 18b: 네 축이 모두 일치하는 문서에는 만료 알림이 나가지 않는다', async () => {
    // no-op sender 스텁과 "일치 시 무알림"을 구분하는 만료 양성 대조군이다.
    await runExpiredTarget('e2e-alert-positive-control', 'fileHash');
    expect(sendAlert).toHaveBeenCalledTimes(1);

    await resetScenario();
    const exact = await runExactTarget('e2e-four-axis-match-no-alert');

    expect(exact.run).toMatchObject({
      status: 'SKIPPED',
      phase: 'PARSE',
    });
    expect(sendAlert).not.toHaveBeenCalled();
  });
});
