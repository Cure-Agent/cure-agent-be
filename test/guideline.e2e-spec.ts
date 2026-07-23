import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { gyeonbitongGuideline, yotongGuideline } from './fixtures/guideline-samples';

const CSRF = { 'X-CSRF-Protection': '1' };

/**
 * docs/specs/05-guideline-evidence.md 수용 기준 동결 테스트.
 * 구현 중 이 파일 수정 금지 — 수정 필요 = 스펙 결함 → spec 개정 후 재동결.
 */
describe('spec 05: Guideline·Evidence + 인제스트', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let ingestService: GuidelineIngestService;
  let authCookie: string;

  let yotongId: string; // 요통 지침 guidelineId (기준 1에서 확보)
  let evidenceId: string; // 기준 6에서 확보

  beforeAll(async () => {
    [container, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();

    ingestService = app.get(GuidelineIngestService);

    // 보호 라우트 접근용 계정
    const signup = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        email: 'guideline-tester@clinic.kr',
        password: 'password-1234',
        displayName: '김의사',
        clinicName: '서울한의원',
        licenseNumber: 'LIC-0042',
        termsAccepted: true,
      })
      .expect(201);
    const setCookies = (signup.headers['set-cookie'] ?? []) as unknown as string[];
    authCookie = setCookies
      .map((raw) => raw.split(';')[0])
      .filter((pair) => pair.startsWith('access_token='))
      .join('; ');
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  const server = () => app.getHttpServer();
  const authedGet = (url: string) => request(server()).get(url).set('Cookie', authCookie);

  it('기준 1: 인제스트 → guideline/version/section/chunk/IngestionRun 저장 + 1536차원 임베딩', async () => {
    const result = await ingestService.ingest(yotongGuideline);
    yotongId = result.guidelineId;

    expect(result.created).toBe(true);
    expect(result.stats).toEqual({ sections: 2, chunks: 3, skippedChunks: 0 });

    const counts = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM guidelines) AS guidelines,
        (SELECT count(*)::int FROM guideline_versions) AS versions,
        (SELECT count(*)::int FROM guideline_sections) AS sections,
        (SELECT count(*)::int FROM evidence_chunks) AS chunks,
        (SELECT count(*)::int FROM ingestion_runs) AS runs
    `);
    expect(counts.rows[0]).toEqual({ guidelines: 1, versions: 1, sections: 2, chunks: 3, runs: 1 });

    const dims = await pool.query(
      'SELECT DISTINCT vector_dims(embedding)::int AS dims FROM evidence_chunks',
    );
    expect(dims.rows).toEqual([{ dims: 1536 }]);
  });

  it('기준 2: 같은 입력 재인제스트 → chunk 중복 없음(멱등) + IngestionRun 신규 기록', async () => {
    const result = await ingestService.ingest(yotongGuideline);
    expect(result.created).toBe(false);
    expect(result.guidelineId).toBe(yotongId);

    const counts = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM evidence_chunks) AS chunks,
        (SELECT count(*)::int FROM ingestion_runs) AS runs
    `);
    expect(counts.rows[0]).toEqual({ chunks: 3, runs: 2 });
  });

  it('기준 3: GET /guidelines 커서 페이지네이션 (중복 없이 전체 순회)', async () => {
    await ingestService.ingest(gyeonbitongGuideline); // 목록 테스트용 두 번째 지침

    const page1 = await authedGet('/api/v1/guidelines').query({ size: 1 }).expect(200);
    expect(page1.body.data).toHaveLength(1);
    expect(page1.body.page).toMatchObject({ size: 1, hasNext: true });
    expect(page1.body.page.nextCursor).toBeTruthy();

    const page2 = await authedGet('/api/v1/guidelines')
      .query({ size: 1, cursor: page1.body.page.nextCursor })
      .expect(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.page.hasNext).toBe(false);

    const ids = [page1.body.data[0].id, page2.body.data[0].id];
    expect(new Set(ids).size).toBe(2);

    const titles = [page1.body.data[0].title, page2.body.data[0].title].sort();
    expect(titles).toEqual(['견비통 한의표준임상진료지침', '요통 한의표준임상진료지침']);
  });

  it('기준 4: GET /guidelines?query= 제목 부분일치 필터', async () => {
    const res = await authedGet('/api/v1/guidelines').query({ query: '요통' }).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      title: '요통 한의표준임상진료지침',
      publisher: '한국한의약진흥원',
      currentVersion: '1.0',
      status: 'ACTIVE',
    });
  });

  it('기준 5: GET /guidelines/{id} 상세(현재 버전 포함) + 미존재 404', async () => {
    const res = await authedGet(`/api/v1/guidelines/${yotongId}`).expect(200);
    expect(res.body.data).toMatchObject({
      id: yotongId,
      title: '요통 한의표준임상진료지침',
      currentVersion: '1.0',
      sourceUrl: 'https://nckm.example.org/guideline/lbp',
    });

    const missing = await authedGet('/api/v1/guidelines/01JUNKNOWNIDXXXXXXXXXXXXXX').expect(404);
    expect(missing.body).toMatchObject({ success: false, code: 'NOT_FOUND' });
  });

  it('기준 6: GET /guidelines/{id}/evidence 섹션 경로·권고등급 포함 목록', async () => {
    const res = await authedGet(`/api/v1/guidelines/${yotongId}/evidence`).expect(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.page).toMatchObject({ hasNext: false });

    const graded = res.body.data.find(
      (item: { recommendationNumber?: string }) => item.recommendationNumber === 'R1',
    );
    expect(graded).toMatchObject({
      sectionPath: ['2', '치료', '침치료'],
      recommendationGrade: { system: 'GRADE', code: 'A', label: '강한 권고' },
      evidenceLevel: { system: 'GRADE', code: 'HIGH', label: '높음' },
    });
    expect(typeof graded.excerpt).toBe('string');
    evidenceId = graded.id;
  });

  it('기준 7: GET /evidence/{id} 상세(sectionPath·excerpt·sourceUrl) + 미존재 404', async () => {
    const res = await authedGet(`/api/v1/evidence/${evidenceId}`).expect(200);
    expect(res.body.data).toMatchObject({
      id: evidenceId,
      guidelineTitle: '요통 한의표준임상진료지침',
      version: '1.0',
      sectionPath: ['2', '치료', '침치료'],
      recommendationNumber: 'R1',
      sourceUrl: 'https://nckm.example.org/guideline/lbp',
      pageStart: 45,
      pageEnd: 46,
    });
    expect(res.body.data.excerpt).toContain('침 치료를 시행할 것을 권고한다');

    const missing = await authedGet('/api/v1/evidence/01JUNKNOWNIDXXXXXXXXXXXXXX').expect(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });

  it('기준 8: 미인증 접근 시 4종 모두 401 UNAUTHORIZED', async () => {
    const urls = [
      '/api/v1/guidelines',
      `/api/v1/guidelines/${yotongId}`,
      `/api/v1/guidelines/${yotongId}/evidence`,
      `/api/v1/evidence/${evidenceId}`,
    ];
    for (const url of urls) {
      const res = await request(server()).get(url).expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    }
  });
});
