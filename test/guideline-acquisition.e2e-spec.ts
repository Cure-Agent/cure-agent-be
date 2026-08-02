import { createHash } from 'crypto';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { GuidelineAcquisitionService } from '../src/domain/guideline/service/guideline-acquisition.service';
import {
  GUIDELINE_SOURCE,
  GuidelineSourceError,
  SourceDownload,
  SourceListItem,
} from '../src/infrastructure/guideline-source/guideline-source.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { FakeGuidelineSource } from './fixtures/fake-guideline-source';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { bootstrapApp } from './fixtures/app-bootstrap';

/**
 * docs/specs/18-guideline-acquisition.md 수용 기준 동결 테스트.
 * 구현 중 이 파일 수정 금지 — 수정 필요 = 스펙 결함 → spec 개정 후 재동결.
 */
describe('spec 18: NCKM 지침 원본 수집', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let acquisitionService: GuidelineAcquisitionService;
  let fakeSource: FakeGuidelineSource;
  let outDir: string;

  const item = (
    externalId: string,
    overrides: Partial<SourceListItem> = {},
  ): SourceListItem => ({
    externalId,
    title: `${externalId} 한의표준임상진료지침`,
    publisher: `${externalId} 발행기관`,
    releaseDate: '2024-07',
    sourceUrl:
      `https://nikom.or.kr/nckm/module/practiceGuide/view.do?guide_idx=${externalId}` +
      '&menu_idx=14',
    ...overrides,
  });

  const pdf = (content: string): SourceDownload => ({
    body: Buffer.from(`%PDF-1.7\n${content}`),
    contentType: 'application/pdf',
  });

  const html = (content: string): SourceDownload => ({
    body: Buffer.from(`<html><body>${content}</body></html>`),
    contentType: 'text/html',
  });

  const sha256 = (body: Buffer): string =>
    createHash('sha256').update(body).digest('hex');

  beforeAll(async () => {
    [container, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE source_documents');
    fakeSource = new FakeGuidelineSource();
    outDir = mkdtempSync(join(tmpdir(), 'cure-guideline-acquisition-'));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(GUIDELINE_SOURCE)
      .useValue(fakeSource)
      .compile();
    app = moduleRef.createNestApplication();
    await bootstrapApp(app);

    acquisitionService = app.get(GuidelineAcquisitionService);
  });

  afterEach(async () => {
    await app?.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  it('기준 1: 목록 N건의 guide_idx·title·agency·release_date를 source_documents에 정확히 매핑한다', async () => {
    const items = [
      item('101', {
        title: '요통 한의표준임상진료지침',
        publisher: '한국한의약진흥원',
        releaseDate: '2024-07',
      }),
      item('102', {
        title: '견비통 한의표준임상진료지침',
        publisher: '대한한방병원협회',
        releaseDate: '2021-12',
      }),
      item('103', {
        title: '일자 미상 지침',
        publisher: '대한한의학회',
        releaseDate: null,
      }),
    ];
    fakeSource.setItems(items);
    items.forEach((sourceItem) => {
      fakeSource.setDownload(sourceItem.externalId, pdf(sourceItem.externalId));
    });

    await acquisitionService.acquire();

    const rows = await pool.query(`
      SELECT
        external_id AS "externalId",
        title,
        publisher,
        release_date AS "releaseDate"
      FROM source_documents
      ORDER BY external_id
    `);
    expect(rows.rows).toEqual([
      {
        externalId: '101',
        title: '요통 한의표준임상진료지침',
        publisher: '한국한의약진흥원',
        releaseDate: '2024-07',
      },
      {
        externalId: '102',
        title: '견비통 한의표준임상진료지침',
        publisher: '대한한방병원협회',
        releaseDate: '2021-12',
      },
      {
        externalId: '103',
        title: '일자 미상 지침',
        publisher: '대한한의학회',
        releaseDate: null,
      },
    ]);
  });

  it('기준 2: application/pdf + %PDF 응답을 FETCHED로 기록하고 본문 sha256·바이트 수를 보존한다', async () => {
    const sourceItem = item('201');
    const download = pdf('fetched guideline');
    fakeSource.setItems([sourceItem]).setDownload(sourceItem.externalId, download);

    await acquisitionService.acquire();

    const rows = await pool.query(`
      SELECT
        status,
        file_hash AS "fileHash",
        file_bytes AS "fileBytes"
      FROM source_documents
      WHERE external_id = '201'
    `);
    expect(rows.rows).toEqual([
      {
        status: 'FETCHED',
        fileHash: sha256(download.body),
        fileBytes: download.body.length,
      },
    ]);
  });

  it('기준 3: text/html 응답은 SKIPPED_NO_ATTACHMENT로 기록하고 파일 없이 다음 문서를 계속 처리한다', async () => {
    const first = item('301');
    const next = item('302');
    const firstDownload = html('attachment not found');
    const nextDownload = html('old version without attachment');
    fakeSource
      .setItems([first, next])
      .setDownload(first.externalId, firstDownload)
      .setDownload(next.externalId, nextDownload);

    await acquisitionService.acquire({ outDir });

    const rows = await pool.query(`
      SELECT
        external_id AS "externalId",
        status,
        file_hash AS "fileHash"
      FROM source_documents
      ORDER BY external_id
    `);
    expect(rows.rows).toEqual([
      {
        externalId: '301',
        status: 'SKIPPED_NO_ATTACHMENT',
        fileHash: sha256(firstDownload.body),
      },
      {
        externalId: '302',
        status: 'SKIPPED_NO_ATTACHMENT',
        fileHash: sha256(nextDownload.body),
      },
    ]);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('기준 4: PDF content-type이지만 %PDF가 아닌 응답은 FAILED로 기록하고 파일을 저장하지 않는다', async () => {
    const sourceItem = item('401');
    const invalidPdf: SourceDownload = {
      body: Buffer.from('this is not a PDF'),
      contentType: 'application/pdf',
    };
    fakeSource.setItems([sourceItem]).setDownload(sourceItem.externalId, invalidPdf);

    await acquisitionService.acquire({ outDir });

    const rows = await pool.query(`
      SELECT
        status,
        file_hash AS "fileHash",
        file_bytes AS "fileBytes",
        content_type AS "contentType",
        error
      FROM source_documents
      WHERE external_id = '401'
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      status: 'FAILED',
      fileHash: sha256(invalidPdf.body),
      fileBytes: invalidPdf.body.length,
      contentType: 'application/pdf',
    });
    expect(rows.rows[0].error).toEqual(expect.any(String));
    expect(rows.rows[0].error.length).toBeGreaterThan(0);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('기준 5: 같은 PDF를 재수집하면 FETCHED 행을 추가하지 않고 fetched_at만 갱신한다', async () => {
    const sourceItem = item('501');
    fakeSource.setItems([sourceItem]).setDownload(sourceItem.externalId, pdf('same PDF'));

    await acquisitionService.acquire();
    await pool.query(`
      UPDATE source_documents
      SET fetched_at = '2000-01-01T00:00:00.000Z'
      WHERE external_id = '501'
    `);

    await acquisitionService.acquire();

    const rows = await pool.query(`
      SELECT status, fetched_at AS "fetchedAt"
      FROM source_documents
      WHERE external_id = '501'
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('FETCHED');
    expect(rows.rows[0].fetchedAt.getTime()).toBeGreaterThan(
      new Date('2000-01-01T00:00:00.000Z').getTime(),
    );
  });

  it('기준 5: 같은 HTML을 재수집하면 SKIPPED_NO_ATTACHMENT 행을 추가하지 않고 fetched_at만 갱신한다', async () => {
    const sourceItem = item('502');
    fakeSource
      .setItems([sourceItem])
      .setDownload(sourceItem.externalId, html('same missing attachment page'));

    await acquisitionService.acquire();
    await pool.query(`
      UPDATE source_documents
      SET fetched_at = '2000-01-01T00:00:00.000Z'
      WHERE external_id = '502'
    `);

    await acquisitionService.acquire();

    const rows = await pool.query(`
      SELECT status, fetched_at AS "fetchedAt"
      FROM source_documents
      WHERE external_id = '502'
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('SKIPPED_NO_ATTACHMENT');
    expect(rows.rows[0].fetchedAt.getTime()).toBeGreaterThan(
      new Date('2000-01-01T00:00:00.000Z').getTime(),
    );
  });

  it('기준 6: 같은 문서의 본문 해시가 바뀌면 새 행을 추가하고 이전 행을 보존한다', async () => {
    const sourceItem = item('601');
    const original = pdf('original revision');
    const revised = pdf('revised content');
    fakeSource.setItems([sourceItem]).setDownload(sourceItem.externalId, original);

    await acquisitionService.acquire();
    fakeSource.setDownload(sourceItem.externalId, revised);
    await acquisitionService.acquire();

    const rows = await pool.query(`
      SELECT status, file_hash AS "fileHash"
      FROM source_documents
      WHERE external_id = '601'
      ORDER BY file_hash
    `);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((row) => row.status)).toEqual(['FETCHED', 'FETCHED']);
    expect(rows.rows.map((row) => row.fileHash).sort()).toEqual(
      [sha256(original.body), sha256(revised.body)].sort(),
    );
  });

  it('기준 7: 한 문서의 네트워크 실패를 FAILED(NULL hash)로 누적하면서 나머지 문서를 계속 처리한다', async () => {
    const failing = item('701');
    const succeeding = item('702');
    fakeSource
      .setItems([failing, succeeding])
      .setFailure(failing.externalId, new GuidelineSourceError('socket closed before body'))
      .setDownload(succeeding.externalId, pdf('available document'));

    await acquisitionService.acquire();

    const firstRun = await pool.query(`
      SELECT
        external_id AS "externalId",
        status,
        file_hash AS "fileHash",
        file_bytes AS "fileBytes",
        content_type AS "contentType",
        error
      FROM source_documents
      ORDER BY external_id
    `);
    expect(firstRun.rows).toHaveLength(2);
    expect(firstRun.rows[0]).toMatchObject({
      externalId: '701',
      status: 'FAILED',
      fileHash: null,
      fileBytes: null,
      contentType: null,
    });
    expect(firstRun.rows[0].error).toContain('socket closed before body');
    expect(firstRun.rows[1]).toMatchObject({
      externalId: '702',
      status: 'FETCHED',
    });

    await acquisitionService.acquire();

    const accumulated = await pool.query(`
      SELECT external_id AS "externalId", status, file_hash AS "fileHash"
      FROM source_documents
      ORDER BY external_id, created_at
    `);
    expect(accumulated.rows).toHaveLength(3);
    expect(
      accumulated.rows.filter(
        (row) =>
          row.externalId === '701' &&
          row.status === 'FAILED' &&
          row.fileHash === null,
      ),
    ).toHaveLength(2);
    expect(
      accumulated.rows.filter(
        (row) => row.externalId === '702' && row.status === 'FETCHED',
      ),
    ).toHaveLength(1);
  });

  it('기준 9: --guide-idx에 대응하는 externalIds로 지정한 문서만 수집한다', async () => {
    const items = [item('901'), item('902'), item('903')];
    fakeSource.setItems(items);
    items.forEach((sourceItem) => {
      fakeSource.setDownload(sourceItem.externalId, pdf(sourceItem.externalId));
    });

    await acquisitionService.acquire({ externalIds: ['902'] });

    const rows = await pool.query(`
      SELECT external_id AS "externalId"
      FROM source_documents
      ORDER BY external_id
    `);
    expect(rows.rows).toEqual([{ externalId: '902' }]);
  });

  it('기준 9: --limit에 대응하는 limit으로 목록 앞에서부터 건수를 제한한다', async () => {
    const items = [item('911'), item('912'), item('913')];
    fakeSource.setItems(items);
    items.forEach((sourceItem) => {
      fakeSource.setDownload(sourceItem.externalId, pdf(sourceItem.externalId));
    });

    await acquisitionService.acquire({ limit: 2 });

    const rows = await pool.query(`
      SELECT external_id AS "externalId"
      FROM source_documents
      ORDER BY external_id
    `);
    expect(rows.rows).toEqual([{ externalId: '911' }, { externalId: '912' }]);
  });
});
