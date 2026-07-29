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
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { GuidelineParseService } from '../src/domain/guideline/service/guideline-parse.service';
import { EMBEDDING_PROVIDER } from '../src/infrastructure/embedding/embedding-provider.port';
import { FakeEmbeddingProvider } from '../src/infrastructure/embedding/fake-embedding.provider';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { nckmSamplePages } from './fixtures/nckm-pages.sample';

interface SourceDocumentSeed {
  externalId: string;
  title: string;
  publisher: string;
  releaseDate: string;
  sourceUrl: string;
}

interface StoredChunkRow {
  recommendationNumber: string;
  recommendationGrade: {
    system: string;
    code: string;
    label: string;
  } | null;
  evidenceLevel: {
    system: string;
    code: string;
    label: string;
  } | null;
}

/**
 * docs/specs/19-guideline-parsing.md 수용 기준 12~13 동결 테스트.
 * 구현 중 이 파일 수정 금지 — 수정 필요 = 스펙 결함 → spec 개정 후 재동결.
 */
describe('spec 19: 지침 PDF 파싱·청킹', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let parseService: GuidelineParseService;
  let ingestService: GuidelineIngestService;

  const insertSourceDocument = async (seed: SourceDocumentSeed): Promise<void> => {
    await pool.query(
      `
        INSERT INTO source_documents (
          id,
          source_system,
          external_id,
          title,
          publisher,
          release_date,
          source_url,
          file_hash,
          file_bytes,
          content_type,
          status,
          error,
          fetched_at
        )
        VALUES (
          $1, 'NCKM', $2, $3, $4, $5, $6, $7, 4096,
          'application/pdf', 'FETCHED', NULL, $8
        )
      `,
      [
        `source-document-${seed.externalId}`,
        seed.externalId,
        seed.title,
        seed.publisher,
        seed.releaseDate,
        seed.sourceUrl,
        `fixture-hash-${seed.externalId}`,
        new Date('2026-03-02T00:00:00.000Z'),
      ],
    );
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(EMBEDDING_PROVIDER)
      .useClass(FakeEmbeddingProvider)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    parseService = app.get(GuidelineParseService);
    ingestService = app.get(GuidelineIngestService);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        evidence_chunks,
        guideline_sections,
        guideline_versions,
        guidelines,
        pipeline_runs,
        guideline_jobs,
        source_documents
      CASCADE
    `);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  it('기준 12: 파싱 결과를 인제스트하면 권고문과 빈 등급의 해설 청크가 함께 적재된다', async () => {
    await insertSourceDocument({
      externalId: '325',
      title: '달빛대사증 한의표준임상진료지침',
      publisher: '가상한의연구원',
      releaseDate: '2024-07',
      sourceUrl: 'https://guidelines.example.test/moonlight-metabolism',
    });

    const parsed = await parseService.parse({
      pages: nckmSamplePages,
      externalId: '325',
    });
    const result = await ingestService.ingest(parsed);

    expect(result.created).toBe(true);
    expect(result.stats).toMatchObject({ chunks: 8, skippedChunks: 0 });

    const counts = await pool.query(`
      SELECT
        (
          count(*) FILTER (WHERE recommendation_grade IS NOT NULL)
        )::int AS recommendations,
        (
          count(*) FILTER (
            WHERE recommendation_number IS NOT NULL
              AND recommendation_grade IS NULL
              AND evidence_level IS NULL
          )
        )::int AS explanations,
        count(*)::int AS total
      FROM evidence_chunks
    `);
    expect(counts.rows[0]).toEqual({
      recommendations: 4,
      explanations: 4,
      total: 8,
    });

    const stored = await pool.query(`
      SELECT
        recommendation_number AS "recommendationNumber",
        recommendation_grade AS "recommendationGrade",
        evidence_level AS "evidenceLevel"
      FROM evidence_chunks
      WHERE recommendation_number = 'R2'
    `);
    const rows = stored.rows as StoredChunkRow[];
    const recommendation = rows.find((row) => row.recommendationGrade !== null);
    const explanation = rows.find((row) => row.recommendationGrade === null);

    expect(recommendation).toEqual({
      recommendationNumber: 'R2',
      recommendationGrade: {
        system: 'GRADE',
        code: 'C',
        label: '약한 권고',
      },
      evidenceLevel: {
        system: 'GRADE',
        code: 'Very Low',
        label: '매우 낮음',
      },
    });
    expect(explanation).toEqual({
      recommendationNumber: 'R2',
      recommendationGrade: null,
      evidenceLevel: null,
    });
  });

  it('기준 13: source_documents의 지정 문서 메타와 월 단위 발행일을 인제스트 메타로 해결한다', async () => {
    await insertSourceDocument({
      externalId: '325',
      title: '달빛대사증 한의표준임상진료지침',
      publisher: '가상한의연구원',
      releaseDate: '2024-07',
      sourceUrl: 'https://guidelines.example.test/moonlight-metabolism',
    });

    const resolved = await parseService.resolveMeta({ externalId: '325' });

    expect(resolved).toEqual({
      title: '달빛대사증 한의표준임상진료지침',
      publisher: '가상한의연구원',
      sourceUrl: 'https://guidelines.example.test/moonlight-metabolism',
      version: '2024-07',
      publishedAt: '2024-07-01',
    });
  });

  it('기준 13: 지정한 source_documents 행이 없으면 메타 해결에 실패한다', async () => {
    await expect(
      parseService.resolveMeta({ externalId: 'missing-guide-idx' }),
    ).rejects.toThrow();
  });
});
