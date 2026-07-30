/**
 * 이슈 #106(2차): 인제스트 대상 판정 수용 기준 7~12.
 *
 * 원본 전체에 권고 마커가 없는 문서와, 원본에는 마커가 있지만 페이지 판정에서
 * 마커 페이지가 탈락한 문서를 같은 잡에 넣어 두 경우가 서로 다르게 종결되는지 검증한다.
 */
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
import { createHash } from 'node:crypto';
import { GuidelineListProvider } from '../src/domain/guideline/service/guideline-list.provider';
import {
  NOT_INGEST_TARGETS,
  type NotIngestTarget,
} from '../src/domain/guideline/service/not-ingest-targets';
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
  nckmNoMarkerPages,
  nckmSamplePages,
} from './fixtures/nckm-pages.sample';
import { socialSignUp, TestSession } from './fixtures/social-auth';

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

/**
 * 두 번째 페이지에만 권고 마커가 있다.
 *
 * 첫 페이지는 인쇄 번호와 대상 장 헤더를 가져 장 판정 자체는 가능하다. 반면 마커가 있는
 * 페이지의 첫 줄은 인쇄 번호가 아니어서 parsePageHeader()가 null을 반환하고 청킹 대상에서
 * 통째로 탈락한다. 따라서 원본 마커 탐색은 true지만 청커 진단의 uniqueNumbers는 0이어야 한다.
 */
const nckmMarkerOnRejectedPageOnly: string[] = [
  [
    '56',
    'IV 권고사항',
    '1 한의 단독 치료',
    '이 페이지에는 권고 마커가 없다.',
  ].join('\n'),
  [
    '인쇄 번호가 아닌 페이지 머리말',
    'IV 권고사항',
    '【 R1 】',
    '권고안 권고등급/근거수준 참고문헌',
    '이 문장은 청킹 전에 페이지와 함께 탈락해야 한다. A/High 1)',
  ].join('\n'),
];

describe('이슈 #106: PARSE 단계 인제스트 대상 판정', () => {
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

  const sourceItem = (
    externalId: string,
    releaseDate = '2024-07',
  ): SourceListItem => ({
    externalId,
    title: `테스트 지침 ${externalId}`,
    publisher: '대한테스트학회',
    releaseDate,
    sourceUrl: `https://example.test/guidelines/${externalId}`,
    fileName: `${externalId}.pdf`,
  });

  /** 주입 목록 — docs/specs/25가 fileHash를 축에 넣어 합성 본문으로는 커밋 항목에 매칭할 수 없다 */
  const injectedTargets: NotIngestTarget[] = [];
  const fakeListProvider = {
    knownSourceDefects: () => [],
    notIngestTargets: () => injectedTargets,
  };

  const syntheticBody = (externalId: string): Buffer =>
    Buffer.from(`%PDF-1.7\nDOC:${externalId}\nfixture`);

  const addPdf = (
    externalId: string,
    pages: string[],
    releaseDate = '2024-07',
  ): void => {
    const marker = `DOC:${externalId}`;
    fakeSource.addDocument(sourceItem(externalId, releaseDate), {
      body: syntheticBody(externalId),
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
      email: 'guideline-ingest-target-admin@clinic.kr',
      providerId: 'guideline-ingest-target-admin',
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

  it('기준 7~12: 원본 마커 유무로 PARSE SKIPPED와 파싱 결함을 구분하고 잡 카운터에 반영한다', async () => {
    // docs/specs/24 기준 10이 SKIPPED의 근거를 「마커 부재」에서 **커밋된 대상 아님 목록**으로
    // 옮겼다. 그래서 마커 없는 문서로 이 경로를 타려면 목록 항목과 (externalId, version)이
    // 맞아야 한다 — 목록에 없는 마커 없는 문서는 이제 FAILED다(그 분기는 spec 24의 e2e가 덮는다).
    const committed = NOT_INGEST_TARGETS[0];
    // 사유·버전은 커밋된 항목 그대로 쓰고 해시만 이 본문의 것으로 바꾼다 (docs/specs/25 기준 15)
    const noMarkerTarget = {
      ...committed,
      fileHash: createHash('sha256')
        .update(syntheticBody(committed.externalId))
        .digest('hex'),
    };
    injectedTargets.push(noMarkerTarget);
    addPdf(noMarkerTarget.externalId, nckmNoMarkerPages, noMarkerTarget.version);
    addPdf('marker-on-rejected-page', nckmMarkerOnRejectedPageOnly);
    addPdf('parse-success', nckmSamplePages);

    const created = await startJob();
    const completed = await waitForJob(created.id);

    // 기준 12: PARSE 단계 SKIPPED는 skipped에만 포함되고 failed에는 포함되지 않는다.
    expect(completed).toMatchObject({
      id: created.id,
      status: 'COMPLETED',
      total: 3,
      processed: 3,
      succeeded: 1,
      skipped: 1,
      failed: 1,
    });
    expect(completed.processed).toBe(
      completed.succeeded + completed.skipped + completed.failed,
    );
    expect(completed.runs).toHaveLength(3);

    const noMarker = completed.runs.find(
      (run) => run.externalId === noMarkerTarget.externalId,
    );
    expect(noMarker).toBeDefined();

    // 기준 7~8: 마커가 원본 어디에도 없으면 실패 정보 없이 PARSE에서 건너뛴다.
    expect(noMarker).toMatchObject({
      status: 'SKIPPED',
      phase: 'PARSE',
      errorCode: null,
      error: null,
    });

    // 기준 9: ACQUIRE와 0건 PARSE 관측값만 남기며 추출된 페이지 수는 보존한다.
    expect(Object.keys(noMarker?.stages ?? {}).sort()).toEqual([
      'acquire',
      'parse',
    ]);
    const noMarkerParse = noMarker?.stages.parse as
      | ParseStageDto
      | undefined;
    expect(noMarkerParse).toBeDefined();
    expect(Object.keys(noMarkerParse ?? {}).sort()).toEqual([
      'chunks',
      'ms',
      'pages',
      'sections',
    ]);
    expect(noMarkerParse).toMatchObject({
      pages: nckmNoMarkerPages.length,
      sections: 0,
      chunks: 0,
      ms: expect.any(Number),
    });
    expect(noMarkerParse?.pages).toBeGreaterThan(0);

    // 기준 10: 원본에 마커가 있으면 청킹 결과가 0건이어도 파서 결함을 숨기지 않는다.
    const rejectedMarker = completed.runs.find(
      (run) => run.externalId === 'marker-on-rejected-page',
    );
    expect(rejectedMarker).toMatchObject({
      status: 'FAILED',
      phase: 'PARSE',
      errorCode: 'GUIDELINE_PARSE_FAILED',
      guidelineVersionId: null,
    });

    // 기준 11: 정상 마커 문서는 기존과 같이 적재까지 성공한다.
    const succeeded = completed.runs.find(
      (run) => run.externalId === 'parse-success',
    );
    expect(succeeded).toMatchObject({
      status: 'SUCCEEDED',
      phase: 'INGEST',
    });
  });
});
