/**
 * docs/specs/21-guideline-admin-api.md 수용 기준 동결 테스트.
 * 구현 중 이 파일 수정 금지 — 수정 필요 = 스펙 결함 → spec 개정 후 재동결.
 */
// 디스크 쓰기 여부만 관찰한다 — 동작은 실제 구현에 위임해야 한다.
// no-op으로 바꾸면 Testcontainers가 withFileLock에서 fs/promises.writeFile로 만드는
// 락 파일이 생기지 않아 lstat ENOENT로 스위트 전체가 죽는다.
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    mkdir: jest.fn(actual.mkdir),
    writeFile: jest.fn(actual.writeFile),
  };
});

import { createHash } from 'node:crypto';
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
import { FakeEmbeddingProvider } from '../src/infrastructure/embedding/fake-embedding.provider';
import {
  GUIDELINE_SOURCE,
  GuidelineSourceError,
  SourceDownload,
  SourceListItem,
} from '../src/infrastructure/guideline-source/guideline-source.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { RetrievalService } from '../src/infrastructure/retrieval/retrieval.service';
import { FakeGuidelineSource } from './fixtures/fake-guideline-source';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { nckmSamplePages } from './fixtures/nckm-pages.sample';
import { socialSignUp, TestSession } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const UNAUTHORIZED_MESSAGE = '인증이 필요합니다.';
const FORBIDDEN_MESSAGE = '권한이 없습니다.';
const NOT_FOUND_MESSAGE = '대상을 찾을 수 없습니다.';
const PARSE_FAILED_MESSAGE = '지침을 파싱하지 못했습니다.';
const SOURCE_UNAVAILABLE_MESSAGE = '지침 원본을 가져오지 못했습니다.';
const VERSION_CITED_MESSAGE =
  '이미 인용된 지침 버전은 삭제할 수 없습니다. 폐기를 사용해주세요.';

interface VersionGraph {
  versionCount: number;
  sectionIds: string[];
  chunkIds: string[];
}

interface PlanDocumentOptions {
  title?: string;
  publisher?: string;
  releaseDate?: string;
  pages?: string[];
  pdfText?: string;
}

describe('spec 21: 지침 코퍼스 관리 API', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let admin: TestSession;
  let member: TestSession;
  let extractedPages = [...nckmSamplePages];

  const fakeSource = new FakeGuidelineSource();
  const fakePdfExtractor = {
    extractPages: jest.fn(async (source: string | Uint8Array): Promise<string[]> => {
      void source;
      return extractedPages.map((page) => page);
    }),
  };
  const mkdirMock = jest.mocked(mkdir);
  const writeFileMock = jest.mocked(writeFile);

  const server = () => app.getHttpServer();

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

  const planPdfDocument = (
    externalId: string,
    options: PlanDocumentOptions = {},
  ): { sourceItem: SourceListItem; download: SourceDownload } => {
    const sourceItem = item(externalId, {
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.publisher === undefined ? {} : { publisher: options.publisher }),
      ...(options.releaseDate === undefined ? {} : { releaseDate: options.releaseDate }),
    });
    const download = pdf(options.pdfText ?? `fixture PDF ${externalId}`);
    extractedPages = [...(options.pages ?? nckmSamplePages)];
    fakeSource.setItems([sourceItem]).setDownload(externalId, download);
    return { sourceItem, download };
  };

  const pipeline = (externalId: string, expectedStatus = 201) =>
    request(server())
      .post('/api/v1/admin/guidelines/pipeline')
      .set(CSRF)
      .set('Cookie', admin.cookie)
      .send({ guideIdx: externalId })
      .expect(expectedStatus);

  const expectErrorEnvelope = (
    response: SupertestResponse,
    code: string,
    message: string,
  ): void => {
    expect(response.body).toEqual(
      expect.objectContaining({
        success: false,
        code,
        message,
        timestamp: expect.any(String),
        traceId: expect.any(String),
      }),
    );
    expect(response.body.page).toBeNull();
  };

  const versionGraph = async (versionId: string): Promise<VersionGraph> => {
    const [versions, sections, chunks] = await Promise.all([
      pool.query(
        'SELECT count(*)::int AS count FROM guideline_versions WHERE id = $1',
        [versionId],
      ),
      pool.query(
        `
          SELECT id
          FROM guideline_sections
          WHERE guideline_version_id = $1
          ORDER BY id
        `,
        [versionId],
      ),
      pool.query(
        `
          SELECT id
          FROM evidence_chunks
          WHERE guideline_version_id = $1
          ORDER BY id
        `,
        [versionId],
      ),
    ]);
    return {
      versionCount: versions.rows[0].count as number,
      sectionIds: sections.rows.map((row) => row.id as string),
      chunkIds: chunks.rows.map((row) => row.id as string),
    };
  };

  const revisedPages = (from: string, to: string): string[] =>
    nckmSamplePages.map((page) => page.replaceAll(from, to));

  beforeAll(async () => {
    [container, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(GUIDELINE_SOURCE)
      .useValue(fakeSource)
      .overrideProvider(EMBEDDING_PROVIDER)
      .useClass(FakeEmbeddingProvider)
      .overrideProvider(PdfTextExtractor)
      .useValue(fakePdfExtractor)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();

    admin = await socialSignUp(app, {
      email: 'guideline-admin@clinic.kr',
      providerId: 'guideline-admin',
    });
    member = await socialSignUp(app, {
      email: 'guideline-member@clinic.kr',
      providerId: 'guideline-member',
    });
    await pool.query(`UPDATE clinicians SET role = 'ADMIN' WHERE id = $1`, [
      admin.clinicianId,
    ]);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
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
    fakeSource.setItems([]);
    extractedPages = [...nckmSamplePages];
    fakePdfExtractor.extractPages.mockClear();
    mkdirMock.mockClear();
    writeFileMock.mockClear();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  it('기준 1: 미인증은 401, MEMBER는 403으로 전 엔드포인트에서 거부한다', async () => {
    // supertest는 listen하지 않은 서버를 스스로 listen했다가 첫 응답 후 닫는다 —
    // 요청을 미리 만들어 두면 두 번째부터 죽은 포트에 붙으므로 호출 시점에 생성한다.
    const requestsFor = (cookie?: string) => {
      const withCookie = <T extends { set: (field: string, val: string) => T }>(call: T): T =>
        cookie ? call.set('Cookie', cookie) : call;
      return [
        () =>
          withCookie(
            request(server())
              .post('/api/v1/admin/guidelines/pipeline')
              .set(CSRF)
              .send({ guideIdx: 'auth-check' }),
          ),
        () => withCookie(request(server()).get('/api/v1/admin/guidelines')),
        () =>
          withCookie(
            request(server())
              .patch('/api/v1/admin/guideline-versions/nonexistent-version')
              .set(CSRF)
              .send({ status: 'SUPERSEDED' }),
          ),
        () =>
          withCookie(
            request(server())
              .delete('/api/v1/admin/guideline-versions/nonexistent-version')
              .set(CSRF),
          ),
      ];
    };

    for (const call of requestsFor()) {
      const response = await call().expect(401);
      expectErrorEnvelope(response, 'UNAUTHORIZED', UNAUTHORIZED_MESSAGE);
    }
    for (const call of requestsFor(member.cookie)) {
      const response = await call().expect(403);
      expectErrorEnvelope(response, 'FORBIDDEN', FORBIDDEN_MESSAGE);
    }
  });

  it('기준 2: ADMIN pipeline은 수집 기록·ACTIVE revision 1·임베딩을 만들고 PDF를 디스크에 쓰지 않는다', async () => {
    const externalId = 'pipeline-success';
    const { download } = planPdfDocument(externalId, {
      title: '달빛대사증 한의표준임상진료지침',
      publisher: '가상한의연구원',
      releaseDate: '2024-07',
    });

    const response = await pipeline(externalId);
    expect(response.body).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          externalId,
          sourceStatus: 'FETCHED',
          created: true,
          guidelineId: expect.any(String),
          guidelineVersionId: expect.any(String),
          version: '2024-07',
          revision: 1,
          status: 'ACTIVE',
          stats: expect.objectContaining({
            sections: expect.any(Number),
            chunks: expect.any(Number),
            skippedChunks: 0,
          }),
        }),
        page: null,
        timestamp: expect.any(String),
        traceId: expect.any(String),
      }),
    );

    const versionId = response.body.data.guidelineVersionId as string;
    expect(response.body.data.stats.sections).toBeGreaterThan(0);
    expect(response.body.data.stats.chunks).toBeGreaterThan(0);
    const sourceRows = await pool.query(
      `
        SELECT
          external_id AS "externalId",
          status,
          file_hash AS "fileHash",
          file_bytes AS "fileBytes",
          content_type AS "contentType"
        FROM source_documents
        WHERE source_system = 'NCKM' AND external_id = $1
      `,
      [externalId],
    );
    expect(sourceRows.rows).toEqual([
      {
        externalId,
        status: 'FETCHED',
        fileHash: createHash('sha256').update(download.body).digest('hex'),
        fileBytes: download.body.length,
        contentType: 'application/pdf',
      },
    ]);

    const versions = await pool.query(
      `
        SELECT
          revision,
          status,
          version,
          guideline_id AS "guidelineId"
        FROM guideline_versions
        WHERE id = $1
      `,
      [versionId],
    );
    expect(versions.rows).toEqual([
      {
        revision: 1,
        status: 'ACTIVE',
        version: '2024-07',
        guidelineId: response.body.data.guidelineId,
      },
    ]);

    const chunks = await pool.query(
      `
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
          count(*) FILTER (WHERE embedding_model = 'fake-embedding-v1')::int AS "rightModel"
        FROM evidence_chunks
        WHERE guideline_version_id = $1
      `,
      [versionId],
    );
    expect(chunks.rows[0].total).toBeGreaterThan(0);
    expect(chunks.rows[0]).toEqual({
      total: response.body.data.stats.chunks,
      embedded: response.body.data.stats.chunks,
      rightModel: response.body.data.stats.chunks,
    });
    const storedGraph = await versionGraph(versionId);
    expect(storedGraph.sectionIds).toHaveLength(response.body.data.stats.sections);
    expect(storedGraph.chunkIds).toHaveLength(response.body.data.stats.chunks);

    expect(fakePdfExtractor.extractPages).toHaveBeenCalledTimes(1);
    const passedSource = fakePdfExtractor.extractPages.mock.calls[0][0];
    expect(typeof passedSource).not.toBe('string');
    expect(Buffer.from(passedSource as Uint8Array)).toEqual(download.body);
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('기준 2: 첨부 없는 문서는 오류 없이 SKIPPED_NO_ATTACHMENT 응답과 수집 기록을 남긴다', async () => {
    const externalId = 'pipeline-no-attachment';
    const sourceItem = item(externalId);
    const download = html('NCKM 문서에 PDF 첨부가 없음');
    fakeSource.setItems([sourceItem]).setDownload(externalId, download);

    const response = await pipeline(externalId);
    expect(response.body.data).toEqual({
      externalId,
      sourceStatus: 'SKIPPED_NO_ATTACHMENT',
      created: false,
      guidelineId: null,
      guidelineVersionId: null,
      version: null,
      revision: null,
      status: null,
      stats: null,
    });

    const rows = await pool.query(
      `
        SELECT status, file_hash AS "fileHash"
        FROM source_documents
        WHERE source_system = 'NCKM' AND external_id = $1
      `,
      [externalId],
    );
    expect(rows.rows).toEqual([
      {
        status: 'SKIPPED_NO_ATTACHMENT',
        fileHash: createHash('sha256').update(download.body).digest('hex'),
      },
    ]);
    const versions = await pool.query(
      'SELECT count(*)::int AS count FROM guideline_versions',
    );
    expect(versions.rows[0].count).toBe(0);
    expect(fakePdfExtractor.extractPages).not.toHaveBeenCalled();
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('기준 2: 원본 다운로드 실패는 502이고 목록에 없는 guideIdx는 404로 구분한다', async () => {
    const unavailableId = 'pipeline-source-unavailable';
    fakeSource
      .setItems([item(unavailableId)])
      .setFailure(unavailableId, new GuidelineSourceError('upstream connection reset'));

    const unavailable = await pipeline(unavailableId, 502);
    expectErrorEnvelope(
      unavailable,
      'GUIDELINE_SOURCE_UNAVAILABLE',
      SOURCE_UNAVAILABLE_MESSAGE,
    );

    const missingId = 'pipeline-source-missing';
    fakeSource.setItems([]);
    const missing = await pipeline(missingId, 404);
    expectErrorEnvelope(missing, 'NOT_FOUND', NOT_FOUND_MESSAGE);

    const nonexistentRows = await pool.query(
      `
        SELECT 1
        FROM source_documents
        WHERE source_system = 'NCKM' AND external_id = $1
      `,
      [missingId],
    );
    expect(nonexistentRows.rows).toHaveLength(0);
    const versions = await pool.query(
      'SELECT count(*)::int AS count FROM guideline_versions',
    );
    expect(versions.rows[0].count).toBe(0);
  });

  it('기준 3: 파싱 가드 실패는 문제 번호를 담은 422이고 guideline_versions를 전혀 바꾸지 않는다', async () => {
    const externalId = 'pipeline-parse-failed';
    const gradeMissingPages = nckmSamplePages.map((page) =>
      page.replace('A/High', '등급 미기재'),
    );
    planPdfDocument(externalId, { pages: gradeMissingPages });

    const before = await pool.query(
      'SELECT count(*)::int AS count FROM guideline_versions',
    );
    const response = await pipeline(externalId, 422);

    expectErrorEnvelope(response, 'GUIDELINE_PARSE_FAILED', PARSE_FAILED_MESSAGE);
    expect(response.body.data).toEqual({
      missing: [],
      duplicated: [],
      gradeMissing: ['R1'],
    });

    const after = await pool.query(
      'SELECT count(*)::int AS count FROM guideline_versions',
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it('기준 4: 같은 내용을 재실행하면 revision은 늘지 않고 created=false이며 ingestion_runs만 1건 늘어난다', async () => {
    const externalId = 'pipeline-idempotent';
    planPdfDocument(externalId, {
      title: '멱등성 지침',
      publisher: '멱등성 학회',
      pdfText: 'same source bytes',
    });

    const first = await pipeline(externalId);
    expect(first.body.data).toMatchObject({
      created: true,
      revision: 1,
      status: 'ACTIVE',
    });
    const guidelineId = first.body.data.guidelineId as string;
    const versionId = first.body.data.guidelineVersionId as string;

    const beforeVersions = await pool.query(
      `
        SELECT count(*)::int AS count
        FROM guideline_versions
        WHERE guideline_id = $1 AND version = '2024-07'
      `,
      [guidelineId],
    );
    const beforeRuns = await pool.query(
      'SELECT count(*)::int AS count FROM ingestion_runs',
    );
    const beforeGraph = await versionGraph(versionId);

    const second = await pipeline(externalId);
    expect(second.body.data).toMatchObject({
      externalId,
      sourceStatus: 'FETCHED',
      created: false,
      guidelineId,
      guidelineVersionId: versionId,
      version: '2024-07',
      revision: 1,
      status: 'ACTIVE',
    });

    const afterVersions = await pool.query(
      `
        SELECT count(*)::int AS count
        FROM guideline_versions
        WHERE guideline_id = $1 AND version = '2024-07'
      `,
      [guidelineId],
    );
    const afterRuns = await pool.query(
      'SELECT count(*)::int AS count FROM ingestion_runs',
    );
    expect(afterVersions.rows[0].count).toBe(beforeVersions.rows[0].count);
    expect(afterRuns.rows[0].count).toBe(beforeRuns.rows[0].count + 1);
    expect(await versionGraph(versionId)).toEqual(beforeGraph);
  });

  it('기준 5: 바뀐 파싱 결과를 재실행하면 revision 2만 ACTIVE가 되고 revision 1 청크는 보존된다', async () => {
    const externalId = 'pipeline-revised';
    planPdfDocument(externalId, {
      title: '재적재 지침',
      publisher: '재적재 학회',
      pdfText: 'original source bytes',
    });
    const first = await pipeline(externalId);
    const guidelineId = first.body.data.guidelineId as string;
    const revision1Id = first.body.data.guidelineVersionId as string;
    const beforeChunks = await pool.query(
      `
        SELECT
          id,
          section_id AS "sectionId",
          content,
          content_hash AS "contentHash",
          "order"
        FROM evidence_chunks
        WHERE guideline_version_id = $1
        ORDER BY id
      `,
      [revision1Id],
    );
    expect(beforeChunks.rows.length).toBeGreaterThan(0);

    planPdfDocument(externalId, {
      title: '재적재 지침',
      publisher: '재적재 학회',
      pdfText: 'original source bytes',
      pages: revisedPages('푸른호흡법', '청록호흡법'),
    });
    const second = await pipeline(externalId);
    const revision2Id = second.body.data.guidelineVersionId as string;
    expect(second.body.data).toMatchObject({
      created: true,
      guidelineId,
      version: '2024-07',
      revision: 2,
      status: 'ACTIVE',
    });
    expect(revision2Id).not.toBe(revision1Id);

    const versions = await pool.query(
      `
        SELECT
          id,
          revision,
          status,
          content_hash AS "contentHash"
        FROM guideline_versions
        WHERE guideline_id = $1 AND version = '2024-07'
        ORDER BY revision
      `,
      [guidelineId],
    );
    expect(
      versions.rows.map((row) => ({
        id: row.id,
        revision: row.revision,
        status: row.status,
      })),
    ).toEqual([
      { id: revision1Id, revision: 1, status: 'SUPERSEDED' },
      { id: revision2Id, revision: 2, status: 'ACTIVE' },
    ]);
    expect(versions.rows[1].contentHash).not.toBe(versions.rows[0].contentHash);

    const preservedChunks = await pool.query(
      `
        SELECT
          id,
          section_id AS "sectionId",
          content,
          content_hash AS "contentHash",
          "order"
        FROM evidence_chunks
        WHERE guideline_version_id = $1
        ORDER BY id
      `,
      [revision1Id],
    );
    expect(preservedChunks.rows).toEqual(beforeChunks.rows);
    expect((await versionGraph(revision2Id)).chunkIds.length).toBeGreaterThan(0);
    expect(fakePdfExtractor.extractPages).toHaveBeenCalledTimes(2);
    const sourceDocuments = await pool.query(
      `
        SELECT count(*)::int AS count
        FROM source_documents
        WHERE source_system = 'NCKM' AND external_id = $1
      `,
      [externalId],
    );
    expect(sourceDocuments.rows[0].count).toBe(1);
  });

  it('기준 6: 검색은 SUPERSEDED revision의 정확 일치 청크도 제외하고 ACTIVE revision만 반환한다', async () => {
    const externalId = 'pipeline-retrieval-isolation';
    planPdfDocument(externalId, {
      title: '검색 격리 지침',
      publisher: '검색 격리 학회',
      pdfText: 'retrieval original bytes',
    });
    const first = await pipeline(externalId);
    const revision1Id = first.body.data.guidelineVersionId as string;

    const oldChunk = await pool.query(
      `
        SELECT content
        FROM evidence_chunks
        WHERE guideline_version_id = $1 AND content LIKE '%푸른호흡법%'
        ORDER BY "order"
        LIMIT 1
      `,
      [revision1Id],
    );
    expect(oldChunk.rows).toHaveLength(1);

    planPdfDocument(externalId, {
      title: '검색 격리 지침',
      publisher: '검색 격리 학회',
      pdfText: 'retrieval original bytes',
      pages: revisedPages('푸른호흡법', '청록호흡법'),
    });
    const second = await pipeline(externalId);
    const revision2Id = second.body.data.guidelineVersionId as string;

    const results = await app
      .get(RetrievalService)
      .search(oldChunk.rows[0].content as string);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.version.id === revision2Id)).toBe(true);
    expect(results.some((result) => result.version.id === revision1Id)).toBe(false);
    expect(results.every((result) => result.version.status === 'ACTIVE')).toBe(true);
  });

  it('기준 7: 목록은 버전 이력을 판본 desc→revision desc로 중첩하고 불투명 커서로 중복·누락 없이 잇는다', async () => {
    const mainTitle = '목록 정렬 지침';
    const mainPublisher = '목록 정렬 학회';

    planPdfDocument('list-main-2024', {
      title: mainTitle,
      publisher: mainPublisher,
      releaseDate: '2024-07',
      pdfText: 'list main 2024 revision 1',
    });
    const mainFirst = await pipeline('list-main-2024');
    const mainGuidelineId = mainFirst.body.data.guidelineId as string;

    planPdfDocument('list-main-2024', {
      title: mainTitle,
      publisher: mainPublisher,
      releaseDate: '2024-07',
      pdfText: 'list main 2024 revision 1',
      pages: revisedPages('푸른호흡법', '청록호흡법'),
    });
    await pipeline('list-main-2024');

    planPdfDocument('list-main-2025', {
      title: mainTitle,
      publisher: mainPublisher,
      releaseDate: '2025-01',
      pdfText: 'list main 2025 revision 1',
      pages: revisedPages('은하뜸', '태양뜸'),
    });
    const mainNewest = await pipeline('list-main-2025');
    expect(mainNewest.body.data.guidelineId).toBe(mainGuidelineId);

    planPdfDocument('list-extra-a', {
      title: '목록 추가 지침 A',
      publisher: '목록 학회 A',
    });
    const extraA = await pipeline('list-extra-a');
    planPdfDocument('list-extra-b', {
      title: '목록 추가 지침 B',
      publisher: '목록 학회 B',
    });
    const extraB = await pipeline('list-extra-b');

    const firstPage = await request(server())
      .get('/api/v1/admin/guidelines')
      .set('Cookie', admin.cookie)
      .query({ size: 2 })
      .expect(200);
    expect(firstPage.body.data).toHaveLength(2);
    expect(firstPage.body.page).toEqual({
      size: 2,
      hasNext: true,
      nextCursor: expect.any(String),
    });
    const cursor = firstPage.body.page.nextCursor as string;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const secondPage = await request(server())
      .get('/api/v1/admin/guidelines')
      .set('Cookie', admin.cookie)
      .query({ size: 2, cursor })
      .expect(200);
    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.page).toEqual({
      size: 2,
      hasNext: false,
      nextCursor: null,
    });

    const expectedGuidelineIds = [
      mainGuidelineId,
      extraA.body.data.guidelineId as string,
      extraB.body.data.guidelineId as string,
    ].sort();
    const combined = [...firstPage.body.data, ...secondPage.body.data];
    const combinedIds = combined.map((guideline) => guideline.id as string);
    expect([...new Set(combinedIds)].sort()).toEqual(expectedGuidelineIds);
    expect(expectedGuidelineIds).not.toContain(cursor);

    const listedMain = combined.find(
      (guideline) => guideline.id === mainGuidelineId,
    );
    expect(listedMain).toMatchObject({
      id: mainGuidelineId,
      title: mainTitle,
      publisher: mainPublisher,
    });

    const expectedVersions = await pool.query(
      `
        SELECT
          gv.id,
          gv.version,
          gv.revision,
          gv.status,
          gv.published_at AS "publishedAt",
          gv.content_hash AS "contentHash",
          count(ec.id)::int AS "chunkCount"
        FROM guideline_versions gv
        LEFT JOIN evidence_chunks ec ON ec.guideline_version_id = gv.id
        WHERE gv.guideline_id = $1
        GROUP BY
          gv.id,
          gv.version,
          gv.revision,
          gv.status,
          gv.published_at,
          gv.content_hash
        ORDER BY gv.version DESC, gv.revision DESC
      `,
      [mainGuidelineId],
    );
    expect(
      expectedVersions.rows.map((row) => ({
        version: row.version,
        revision: row.revision,
        status: row.status,
      })),
    ).toEqual([
      { version: '2025-01', revision: 1, status: 'ACTIVE' },
      { version: '2024-07', revision: 2, status: 'ACTIVE' },
      { version: '2024-07', revision: 1, status: 'SUPERSEDED' },
    ]);
    expect(listedMain.versions).toEqual(
      expectedVersions.rows.map((row) => ({
        id: row.id,
        version: row.version,
        revision: row.revision,
        status: row.status,
        publishedAt: (row.publishedAt as Date).toISOString(),
        contentHash: row.contentHash,
        chunkCount: row.chunkCount,
      })),
    );
  });

  it('기준 8: PATCH는 지정 버전만 왕복 전환하고 검색을 갱신하며 미존재 버전은 404다', async () => {
    const title = '상태 전환 지침';
    const publisher = '상태 전환 학회';
    planPdfDocument('status-2024', {
      title,
      publisher,
      releaseDate: '2024-07',
      pdfText: 'status version 2024',
    });
    const target = await pipeline('status-2024');
    const guidelineId = target.body.data.guidelineId as string;
    const targetVersionId = target.body.data.guidelineVersionId as string;

    planPdfDocument('status-2025', {
      title,
      publisher,
      releaseDate: '2025-01',
      pdfText: 'status version 2025',
      pages: revisedPages('별빛탕', '태양빛탕'),
    });
    const other = await pipeline('status-2025');
    const otherVersionId = other.body.data.guidelineVersionId as string;
    expect(other.body.data.guidelineId).toBe(guidelineId);

    const targetChunk = await pool.query(
      `
        SELECT content
        FROM evidence_chunks
        WHERE guideline_version_id = $1 AND content LIKE '%별빛탕%'
        ORDER BY "order"
        LIMIT 1
      `,
      [targetVersionId],
    );
    const beforeSearch = await app
      .get(RetrievalService)
      .search(targetChunk.rows[0].content as string);
    expect(beforeSearch.some((result) => result.version.id === targetVersionId)).toBe(
      true,
    );

    const superseded = await request(server())
      .patch(`/api/v1/admin/guideline-versions/${targetVersionId}`)
      .set(CSRF)
      .set('Cookie', admin.cookie)
      .send({ status: 'SUPERSEDED' })
      .expect(200);
    expect(superseded.body.data).toEqual(
      expect.objectContaining({
        id: targetVersionId,
        version: '2024-07',
        revision: 1,
        status: 'SUPERSEDED',
        publishedAt: expect.any(String),
        contentHash: expect.any(String),
        chunkCount: expect.any(Number),
      }),
    );

    const statusesAfterDiscard = await pool.query(
      `
        SELECT id, status
        FROM guideline_versions
        WHERE id = ANY($1::text[])
        ORDER BY id
      `,
      [[targetVersionId, otherVersionId]],
    );
    expect(
      Object.fromEntries(
        statusesAfterDiscard.rows.map((row) => [row.id as string, row.status]),
      ),
    ).toEqual({
      [targetVersionId]: 'SUPERSEDED',
      [otherVersionId]: 'ACTIVE',
    });

    const afterSearch = await app
      .get(RetrievalService)
      .search(targetChunk.rows[0].content as string);
    expect(afterSearch.length).toBeGreaterThan(0);
    expect(afterSearch.some((result) => result.version.id === targetVersionId)).toBe(
      false,
    );
    expect(afterSearch.every((result) => result.version.id === otherVersionId)).toBe(
      true,
    );

    const promoted = await request(server())
      .patch(`/api/v1/admin/guideline-versions/${targetVersionId}`)
      .set(CSRF)
      .set('Cookie', admin.cookie)
      .send({ status: 'ACTIVE' })
      .expect(200);
    expect(promoted.body.data.status).toBe('ACTIVE');

    const statusesAfterPromotion = await pool.query(
      `
        SELECT id, status
        FROM guideline_versions
        WHERE id = ANY($1::text[])
        ORDER BY id
      `,
      [[targetVersionId, otherVersionId]],
    );
    expect(
      Object.fromEntries(
        statusesAfterPromotion.rows.map((row) => [row.id as string, row.status]),
      ),
    ).toEqual({
      [targetVersionId]: 'ACTIVE',
      [otherVersionId]: 'ACTIVE',
    });

    const missing = await request(server())
      .patch('/api/v1/admin/guideline-versions/does-not-exist')
      .set(CSRF)
      .set('Cookie', admin.cookie)
      .send({ status: 'SUPERSEDED' })
      .expect(404);
    expectErrorEnvelope(missing, 'NOT_FOUND', NOT_FOUND_MESSAGE);
  });

  it('기준 9: 인용 없는 버전 DELETE는 그 청크·섹션·버전만 지우고 같은 지침의 다른 버전을 보존한다', async () => {
    const title = '선택 삭제 지침';
    const publisher = '선택 삭제 학회';
    planPdfDocument('delete-2024', {
      title,
      publisher,
      releaseDate: '2024-07',
      pdfText: 'delete version 2024',
    });
    const target = await pipeline('delete-2024');
    const guidelineId = target.body.data.guidelineId as string;
    const targetVersionId = target.body.data.guidelineVersionId as string;

    planPdfDocument('delete-2025', {
      title,
      publisher,
      releaseDate: '2025-01',
      pdfText: 'delete version 2025',
      pages: revisedPages('은하뜸', '햇빛뜸'),
    });
    const other = await pipeline('delete-2025');
    const otherVersionId = other.body.data.guidelineVersionId as string;
    expect(other.body.data.guidelineId).toBe(guidelineId);

    const targetBefore = await versionGraph(targetVersionId);
    const otherBefore = await versionGraph(otherVersionId);
    const otherVersionBefore = await pool.query(
      `
        SELECT
          id,
          guideline_id AS "guidelineId",
          version,
          revision,
          status,
          content_hash AS "contentHash"
        FROM guideline_versions
        WHERE id = $1
      `,
      [otherVersionId],
    );
    expect(targetBefore.versionCount).toBe(1);
    expect(targetBefore.sectionIds.length).toBeGreaterThan(0);
    expect(targetBefore.chunkIds.length).toBeGreaterThan(0);

    const response = await request(server())
      .delete(`/api/v1/admin/guideline-versions/${targetVersionId}`)
      .set(CSRF)
      .set('Cookie', admin.cookie)
      .expect(204);
    expect(response.text).toBe('');

    expect(await versionGraph(targetVersionId)).toEqual({
      versionCount: 0,
      sectionIds: [],
      chunkIds: [],
    });
    expect(await versionGraph(otherVersionId)).toEqual(otherBefore);
    const otherVersionAfter = await pool.query(
      `
        SELECT
          id,
          guideline_id AS "guidelineId",
          version,
          revision,
          status,
          content_hash AS "contentHash"
        FROM guideline_versions
        WHERE id = $1
      `,
      [otherVersionId],
    );
    expect(otherVersionAfter.rows).toEqual(otherVersionBefore.rows);

    const guideline = await pool.query(
      `
        SELECT
          g.id,
          count(gv.id)::int AS "versionCount"
        FROM guidelines g
        LEFT JOIN guideline_versions gv ON gv.guideline_id = g.id
        WHERE g.id = $1
        GROUP BY g.id
      `,
      [guidelineId],
    );
    expect(guideline.rows).toEqual([{ id: guidelineId, versionCount: 1 }]);
  });

  it('기준 9: 마지막 버전을 DELETE하면 빈 guidelines 행도 제거되고 같은 versionId 재삭제는 404다', async () => {
    const externalId = 'delete-last-version';
    planPdfDocument(externalId, {
      title: '마지막 버전 삭제 지침',
      publisher: '마지막 버전 삭제 학회',
    });
    const created = await pipeline(externalId);
    const guidelineId = created.body.data.guidelineId as string;
    const versionId = created.body.data.guidelineVersionId as string;

    await request(server())
      .delete(`/api/v1/admin/guideline-versions/${versionId}`)
      .set(CSRF)
      .set('Cookie', admin.cookie)
      .expect(204);

    expect(await versionGraph(versionId)).toEqual({
      versionCount: 0,
      sectionIds: [],
      chunkIds: [],
    });
    const guideline = await pool.query('SELECT 1 FROM guidelines WHERE id = $1', [
      guidelineId,
    ]);
    expect(guideline.rows).toHaveLength(0);

    const missing = await request(server())
      .delete(`/api/v1/admin/guideline-versions/${versionId}`)
      .set(CSRF)
      .set('Cookie', admin.cookie)
      .expect(404);
    expectErrorEnvelope(missing, 'NOT_FOUND', NOT_FOUND_MESSAGE);
  });

  it('기준 10: 인용된 버전 DELETE는 409이고 청크·섹션·버전을 하나도 부분 삭제하지 않는다', async () => {
    const externalId = 'delete-cited';
    planPdfDocument(externalId, {
      title: '인용 보존 지침',
      publisher: '인용 보존 학회',
    });
    const created = await pipeline(externalId);
    const versionId = created.body.data.guidelineVersionId as string;
    const before = await versionGraph(versionId);
    const citedChunkId = before.chunkIds[0];

    await pool.query(
      `
        INSERT INTO conversations (
          id, clinician_id, clinic_id, type, title
        )
        VALUES (
          'spec21-cited-conversation', $1, $2, 'GUIDELINE_QA', '인용 삭제 방어'
        )
      `,
      [admin.clinicianId, admin.clinicId],
    );
    await pool.query(`
      INSERT INTO messages (
        id, conversation_id, role, content, status, answer_kind
      )
      VALUES (
        'spec21-cited-message',
        'spec21-cited-conversation',
        'ASSISTANT',
        '인용이 있는 답변',
        'COMPLETED',
        'GUIDELINE_ANSWER'
      )
    `);
    await pool.query(
      `
        INSERT INTO message_citations (
          id, message_id, evidence_chunk_id, marker, quote
        )
        VALUES (
          'spec21-citation',
          'spec21-cited-message',
          $1,
          1,
          '역사적으로 보존되어야 하는 인용'
        )
      `,
      [citedChunkId],
    );

    const response = await request(server())
      .delete(`/api/v1/admin/guideline-versions/${versionId}`)
      .set(CSRF)
      .set('Cookie', admin.cookie)
      .expect(409);
    expectErrorEnvelope(
      response,
      'GUIDELINE_VERSION_CITED',
      VERSION_CITED_MESSAGE,
    );

    expect(await versionGraph(versionId)).toEqual(before);
    const citation = await pool.query(
      `
        SELECT evidence_chunk_id AS "evidenceChunkId"
        FROM message_citations
        WHERE id = 'spec21-citation'
      `,
    );
    expect(citation.rows).toEqual([{ evidenceChunkId: citedChunkId }]);
  });
});
