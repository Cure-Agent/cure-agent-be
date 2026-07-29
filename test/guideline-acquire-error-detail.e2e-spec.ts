// issue #102 수용 기준 동결 테스트 — 구현 중 수정 금지
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
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { GuidelineAcquisitionService } from '../src/domain/guideline/service/guideline-acquisition.service';
import { GuidelinePipelineService } from '../src/domain/guideline/service/guideline-pipeline.service';
import {
  GUIDELINE_SOURCE,
  GuidelineSourceError,
  SourceDownload,
  SourceListItem,
} from '../src/infrastructure/guideline-source/guideline-source.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { FakeGuidelineSource } from './fixtures/fake-guideline-source';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';

jest.setTimeout(120_000);

interface SourceDocumentErrorRow {
  status: string;
  error: string | null;
}

interface PipelineRunErrorRow {
  status: string;
  error_code: string | null;
  error: string | null;
}

function item(externalId: string): SourceListItem {
  return {
    externalId,
    title: `수용 기준 지침 ${externalId}`,
    publisher: 'NCKM',
    releaseDate: '2025-01-01',
    sourceUrl: `https://nikom.or.kr/nckm/module/practiceGuide/view.do?guide_idx=${externalId}`,
    fileName: `${externalId}.pdf`,
  };
}

function pdf(): SourceDownload {
  return {
    body: Buffer.from(
      '%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF',
    ),
    contentType: 'application/pdf',
  };
}

function html(): SourceDownload {
  return {
    body: Buffer.from('<html><body>첨부 파일이 없습니다.</body></html>'),
    contentType: 'text/html',
  };
}

describe('지침 수집 실패 사유 보존', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let fakeSource: FakeGuidelineSource;
  let acquisitionService: GuidelineAcquisitionService;
  let pipelineService: GuidelinePipelineService;

  beforeAll(async () => {
    [container, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    await migrate(drizzle(pool), {
      migrationsFolder: 'drizzle/migrations',
    });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE source_documents, pipeline_runs');
    fakeSource = new FakeGuidelineSource();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(GUIDELINE_SOURCE)
      .useValue(fakeSource)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    acquisitionService = app.get(GuidelineAcquisitionService);
    pipelineService = app.get(GuidelinePipelineService);
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  it('FAILED에는 저장된 실패 사유를 반환하고 FETCHED와 SKIPPED에는 error가 없다', async () => {
    const fetchedItem = item('115');
    const skippedItem = item('116');
    const failedItem = item('117');
    const failureReason = 'NCKM 다운로드 실패 guide_idx=117 (500)';

    fakeSource
      .setItems([fetchedItem, skippedItem, failedItem])
      .setDownload(fetchedItem.externalId, pdf())
      .setDownload(skippedItem.externalId, html())
      .setFailure(
        failedItem.externalId,
        new GuidelineSourceError(failureReason),
      );

    const fetched = await acquisitionService.acquireDocument(
      fetchedItem.externalId,
    );
    const skipped = await acquisitionService.acquireDocument(
      skippedItem.externalId,
    );
    const failed = await acquisitionService.acquireDocument(
      failedItem.externalId,
    );
    const storedResult = await pool.query<SourceDocumentErrorRow>(
      'SELECT status, error FROM source_documents WHERE external_id = $1',
      [failedItem.externalId],
    );
    const storedFailed = storedResult.rows[0];

    expect(storedResult.rows).toHaveLength(1);
    expect({
      fetched: {
        status: fetched?.status,
        error: fetched?.error,
      },
      skipped: {
        status: skipped?.status,
        error: skipped?.error,
      },
      failed: {
        status: failed?.status,
        error: failed?.error,
      },
      storedFailed: {
        status: storedFailed?.status,
        error: storedFailed?.error,
      },
      failedErrorMatchesStored: failed?.error === storedFailed?.error,
    }).toEqual({
      fetched: {
        status: 'FETCHED',
        error: null,
      },
      skipped: {
        status: 'SKIPPED_NO_ATTACHMENT',
        error: null,
      },
      failed: {
        status: 'FAILED',
        error: failureReason,
      },
      storedFailed: {
        status: 'FAILED',
        error: failureReason,
      },
      failedErrorMatchesStored: true,
    });
  });

  it('ACQUIRE 실패 사유를 기존 에러 코드와 함께 pipeline_runs에 기록한다', async () => {
    const failedItem = item('117');
    const failureReason = 'NCKM 다운로드 실패 guide_idx=117 (500)';

    fakeSource
      .setItems([failedItem])
      .setFailure(
        failedItem.externalId,
        new GuidelineSourceError(failureReason),
      );

    const outcome = await pipelineService.runOne({
      externalId: failedItem.externalId,
      jobId: null,
      order: 0,
    });
    const storedResult = await pool.query<PipelineRunErrorRow>(
      `SELECT status, error_code, error
       FROM pipeline_runs
       WHERE external_id = $1`,
      [failedItem.externalId],
    );
    const storedRun = storedResult.rows[0];

    expect(storedResult.rows).toHaveLength(1);
    expect({
      outcome: {
        status: outcome.run.status,
        phase: outcome.run.phase,
        errorCode: outcome.run.errorCode,
        error: outcome.run.error,
      },
      storedRun: {
        status: storedRun?.status,
        errorCode: storedRun?.error_code,
        error: storedRun?.error,
      },
      storedErrorIsDetailed:
        storedRun?.error !== '지침 원본을 가져오지 못했습니다.',
    }).toEqual({
      outcome: {
        status: 'FAILED',
        phase: 'ACQUIRE',
        errorCode: 'GUIDELINE_SOURCE_UNAVAILABLE',
        error: failureReason,
      },
      storedRun: {
        status: 'FAILED',
        errorCode: 'GUIDELINE_SOURCE_UNAVAILABLE',
        error: failureReason,
      },
      storedErrorIsDetailed: true,
    });
  });
});
