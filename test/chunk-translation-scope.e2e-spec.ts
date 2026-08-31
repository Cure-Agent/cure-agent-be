// #394 수용 기준 1~8 동결 테스트 — 구현 중 수정 금지

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
import { AppModule } from '../src/app.module';
import {
  ChunkTranslationJobResult,
  ChunkTranslatorService,
} from '../src/domain/guideline/service/chunk-translator.service';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import {
  TRANSLATOR,
  type SupportedLang,
  type Translator,
} from '../src/infrastructure/llm/translation/translator.port';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';

const EMBEDDING = `[${Array.from({ length: 1536 }, () => '0.001').join(',')}]`;

interface SeedTranslation {
  content: string;
  titleTranslated: string | null;
  sectionPathTranslated: string[] | null;
  sourceContentHash: string;
  translatorModel: string;
}

interface SeedChunk {
  id: string;
  content: string;
  contentHash: string;
  translation?: SeedTranslation;
}

interface SeedGuideline {
  key: string;
  title: string;
  path: string[];
  chunks: SeedChunk[];
}

interface SeededTarget {
  chunkId: string;
  guidelineTitle: string;
  path: string[];
  content: string;
  contentHash: string;
}

interface TranslationSnapshot {
  content: string;
  title_translated: string | null;
  section_path_translated: string[] | null;
  translator_model: string;
  source_content_hash: string;
}

class RecordingTranslator implements Translator {
  readonly model = 'issue394-recording-translator-v1';
  readonly calls: Array<{ text: string; target: SupportedLang }> = [];
  private failingText: string | null = null;

  translate(text: string, target: SupportedLang): Promise<string> {
    this.calls.push({ text, target });
    if (text === this.failingText) {
      return Promise.reject(
        new Error(`issue394 deterministic translation failure: ${text}`),
      );
    }
    return Promise.resolve(`[${target}] ${text}`);
  }

  failOn(text: string): void {
    this.failingText = text;
  }

  clearCalls(): void {
    this.calls.length = 0;
  }

  reset(): void {
    this.clearCalls();
    this.failingText = null;
  }
}

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

function translatedPath(path: readonly string[]): string[] {
  return path.map((segment) => `[en] ${segment}`);
}

async function seedGuideline(pool: Pool, fixture: SeedGuideline): Promise<void> {
  const guidelineId = `issue394-guideline-${fixture.key}`;
  const versionId = `issue394-version-${fixture.key}`;
  const sectionId = `issue394-section-${fixture.key}`;

  await pool.query(
    `INSERT INTO guidelines (id, title, publisher, status)
     VALUES ($1, $2, $3, 'ACTIVE')`,
    [guidelineId, fixture.title, `#394 ${fixture.key} 합성 발행처`],
  );
  await pool.query(
    `INSERT INTO guideline_versions
       (id, guideline_id, version, revision, status, published_at, source_url, content_hash)
     VALUES ($1, $2, '1.0', 1, 'ACTIVE', $3, $4, $5)`,
    [
      versionId,
      guidelineId,
      new Date('2026-08-31T00:00:00.000Z'),
      `https://example.test/issue394/${fixture.key}`,
      `issue394-document-hash-${fixture.key}`,
    ],
  );
  await pool.query(
    `INSERT INTO guideline_sections
       (id, guideline_version_id, title, path, "order")
     VALUES ($1, $2, $3, $4, 1)`,
    [sectionId, versionId, `#394 ${fixture.key} 합성 섹션`, fixture.path],
  );

  for (const [index, chunk] of fixture.chunks.entries()) {
    await pool.query(
      `INSERT INTO evidence_chunks
         (id, section_id, guideline_version_id, content, embedding, embedding_model,
          "order", content_hash)
       VALUES ($1, $2, $3, $4, $5::vector, 'fake-embedding-v1', $6, $7)`,
      [
        chunk.id,
        sectionId,
        versionId,
        chunk.content,
        EMBEDDING,
        index + 1,
        chunk.contentHash,
      ],
    );

    if (chunk.translation !== undefined) {
      await pool.query(
        `INSERT INTO evidence_chunk_translations
           (id, chunk_id, lang, content, title_translated, section_path_translated,
            source_content_hash, translator_model)
         VALUES ($1, $2, 'en', $3, $4, $5, $6, $7)`,
        [
          `issue394-translation-${chunk.id}`,
          chunk.id,
          chunk.translation.content,
          chunk.translation.titleTranslated,
          chunk.translation.sectionPathTranslated,
          chunk.translation.sourceContentHash,
          chunk.translation.translatorModel,
        ],
      );
    }
  }
}

async function translationOf(
  pool: Pool,
  chunkId: string,
): Promise<TranslationSnapshot> {
  const result = await pool.query<TranslationSnapshot>(
    `SELECT content, title_translated, section_path_translated,
            translator_model, source_content_hash
     FROM evidence_chunk_translations
     WHERE chunk_id = $1 AND lang = 'en'`,
    [chunkId],
  );
  if (result.rows.length !== 1) {
    throw new Error(`${chunkId}의 영문 번역 행이 정확히 하나가 아닙니다.`);
  }
  return result.rows[0];
}

async function translationCount(pool: Pool, chunkId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM evidence_chunk_translations
     WHERE chunk_id = $1 AND lang = 'en'`,
    [chunkId],
  );
  return result.rows[0].count;
}

describe('#394: 청크 본문 stale과 섹션 경로 누락의 번역 범위 분리', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;

  const translator = new RecordingTranslator();

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const originalAnswerabilityGate = process.env.LLM_ANSWERABILITY_GATE_ENABLED;

  const runJob = (): Promise<ChunkTranslationJobResult> =>
    app.get(ChunkTranslatorService).translatePending({
      scope: 'demo',
      target: 'en',
    });

  const seedPathOnly = async (
    key: string,
    path: string[] = [
      `${key} 합성 상위 경로`,
      `${key} 합성 하위 경로`,
    ],
  ): Promise<SeededTarget> => {
    const chunkId = `issue394-chunk-${key}`;
    const guidelineTitle = `편두통 ${key} 합성 경로 전용 지침`;
    const content = `${key} 경로 전용 범위를 검증하는 합성 청크 본문입니다.`;
    const contentHash = `issue394-current-hash-${key}`;

    await seedGuideline(pool, {
      key,
      title: guidelineTitle,
      path,
      chunks: [
        {
          id: chunkId,
          content,
          contentHash,
          translation: {
            content: `${key} 보존 대상 합성 영문 본문`,
            titleTranslated: `${key} Preserved Synthetic Guideline`,
            sectionPathTranslated: null,
            sourceContentHash: contentHash,
            translatorModel: `issue394-preserved-model-${key}`,
          },
        },
      ],
    });

    return { chunkId, guidelineTitle, path, content, contentHash };
  };

  const seedStale = async (key: string): Promise<SeededTarget> => {
    const chunkId = `issue394-chunk-${key}`;
    const guidelineTitle = `만성 요통 ${key} 합성 개정 지침`;
    const path = [`${key} 합성 개정 상위 경로`, `${key} 합성 개정 하위 경로`];
    const content = `${key} 원문 개정 뒤의 합성 청크 본문입니다.`;
    const contentHash = `issue394-current-hash-${key}`;

    await seedGuideline(pool, {
      key,
      title: guidelineTitle,
      path,
      chunks: [
        {
          id: chunkId,
          content,
          contentHash,
          translation: {
            content: `${key} obsolete synthetic body`,
            titleTranslated: null,
            sectionPathTranslated: [
              `${key} obsolete parent`,
              `${key} obsolete child`,
            ],
            sourceContentHash: `issue394-obsolete-hash-${key}`,
            translatorModel: `issue394-obsolete-model-${key}`,
          },
        },
      ],
    });

    return { chunkId, guidelineTitle, path, content, contentHash };
  };

  const seedMissing = async (key: string): Promise<SeededTarget> => {
    const chunkId = `issue394-chunk-${key}`;
    const guidelineTitle = `골다공증 ${key} 합성 신규 번역 지침`;
    const path = [`${key} 합성 신규 상위 경로`, `${key} 합성 신규 하위 경로`];
    const content = `${key} 번역 행이 아직 없는 합성 청크 본문입니다.`;
    const contentHash = `issue394-current-hash-${key}`;

    await seedGuideline(pool, {
      key,
      title: guidelineTitle,
      path,
      chunks: [{ id: chunkId, content, contentHash }],
    });

    return { chunkId, guidelineTitle, path, content, contentHash };
  };

  beforeAll(async () => {
    [postgresContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = postgresContainer.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();
    process.env.OPENAI_API_KEY = '';
    process.env.ANTHROPIC_API_KEY = '';
    process.env.LLM_ANSWERABILITY_GATE_ENABLED = 'false';

    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(TRANSLATOR)
      .useValue(translator)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);
  });

  beforeEach(async () => {
    translator.reset();
    await pool.query(
      `TRUNCATE TABLE evidence_chunk_translations, evidence_chunks,
         guideline_sections, guideline_versions, guidelines CASCADE`,
    );
  });

  afterAll(async () => {
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('REDIS_URL', originalRedisUrl);
    restoreEnv('OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnv('ANTHROPIC_API_KEY', originalAnthropicApiKey);
    restoreEnv('LLM_ANSWERABILITY_GATE_ENABLED', originalAnswerabilityGate);

    await app?.close();
    await pool?.end();
    await Promise.all([
      postgresContainer?.stop(),
      redisContainer?.stop(),
    ]);
  });

  it('[기준 1] 본문 해시는 최신이고 경로만 NULL이면 청크 본문을 번역기에 보내지 않는다', async () => {
    const target = await seedPathOnly('criterion-1');

    await runJob();

    expect(translator.calls.map((call) => call.text)).not.toContain(
      target.content,
    );
  });

  it('[기준 2] 경로만 NULL인 행에는 원문과 길이·순서가 대응하는 번역 경로를 채운다', async () => {
    const target = await seedPathOnly('criterion-2');

    const result = await runJob();
    const after = await translationOf(pool, target.chunkId);

    expect(after.section_path_translated).toHaveLength(target.path.length);
    expect(after.section_path_translated).toEqual(translatedPath(target.path));
    for (const [index, segment] of target.path.entries()) {
      expect(after.section_path_translated?.[index]).toBe(`[en] ${segment}`);
    }
    expect(result.pathFilled).toBe(1);
  });

  it('[기준 3] 경로만 채울 때 기존 본문 provenance 네 컬럼을 각각 보존한다', async () => {
    const target = await seedPathOnly('criterion-3');
    const before = await translationOf(pool, target.chunkId);

    await runJob();
    const after = await translationOf(pool, target.chunkId);

    expect(after.content).toBe(before.content);
    expect(after.title_translated).toBe(before.title_translated);
    expect(after.translator_model).toBe(before.translator_model);
    expect(after.source_content_hash).toBe(before.source_content_hash);
  });

  it('[기준 4a] 본문 해시가 어긋난 행은 본문·제목·경로를 모두 다시 쓴다', async () => {
    const target = await seedStale('criterion-4a');
    const before = await translationOf(pool, target.chunkId);

    await runJob();
    const after = await translationOf(pool, target.chunkId);

    expect(after.content).not.toBe(before.content);
    expect(after.content).toBe(`[en] ${target.content}`);
    expect(after.title_translated).toBe(`[en] ${target.guidelineTitle}`);
    expect(after.section_path_translated).toEqual(translatedPath(target.path));
  });

  it('[기준 4b] 본문 해시가 어긋난 행의 원천 해시는 현재 content_hash로 바뀐다', async () => {
    const target = await seedStale('criterion-4b');

    await runJob();
    const after = await translationOf(pool, target.chunkId);

    expect(after.source_content_hash).toBe(target.contentHash);
  });

  it('[기준 5a] 번역 행이 없는 청크는 행이 새로 생기고 본문이 채워진다', async () => {
    const target = await seedMissing('criterion-5a');
    expect(await translationCount(pool, target.chunkId)).toBe(0);

    await runJob();
    const after = await translationOf(pool, target.chunkId);

    expect(await translationCount(pool, target.chunkId)).toBe(1);
    expect(after.content).toBe(`[en] ${target.content}`);
  });

  it('[기준 5b] 번역 행이 없는 청크의 새 행에는 섹션 경로도 모두 채워진다', async () => {
    const target = await seedMissing('criterion-5b');

    await runJob();
    const after = await translationOf(pool, target.chunkId);

    expect(after.section_path_translated).toEqual(translatedPath(target.path));
  });

  it('[기준 6] 한 실행에 섞인 본문 번역과 경로 전용 갱신을 translated·pathFilled로 나눠 센다', async () => {
    const key = 'criterion-6';
    const guidelineTitle = `류마티스 관절염 ${key} 합성 혼합 지침`;
    const path = [`${key} 합성 혼합 상위 경로`, `${key} 합성 혼합 하위 경로`];
    const pathOnlyHash = `issue394-current-hash-${key}-path`;
    const staleHash = `issue394-current-hash-${key}-stale`;

    await seedGuideline(pool, {
      key,
      title: guidelineTitle,
      path,
      chunks: [
        {
          id: `issue394-chunk-${key}-path`,
          content: `${key} 경로만 비어 있는 합성 본문입니다.`,
          contentHash: pathOnlyHash,
          translation: {
            content: `${key} preserved synthetic body`,
            titleTranslated: `${key} Preserved Synthetic Guideline`,
            sectionPathTranslated: null,
            sourceContentHash: pathOnlyHash,
            translatorModel: `issue394-preserved-model-${key}`,
          },
        },
        {
          id: `issue394-chunk-${key}-stale`,
          content: `${key} 해시가 어긋난 합성 본문입니다.`,
          contentHash: staleHash,
          translation: {
            content: `${key} obsolete synthetic body`,
            titleTranslated: `${key} Preserved Synthetic Guideline`,
            sectionPathTranslated: translatedPath(path),
            sourceContentHash: `issue394-obsolete-hash-${key}`,
            translatorModel: `issue394-obsolete-model-${key}`,
          },
        },
      ],
    });

    const result = await runJob();

    expect(result.translated).toBe(1);
    expect(result.pathFilled).toBe(1);
  });

  it('[기준 7] 같은 잡의 두 번째 실행은 행·카운터·번역기 호출 모두 멱등이다', async () => {
    const target = await seedPathOnly('criterion-7');
    const before = await translationCount(pool, target.chunkId);

    const first = await runJob();
    const afterFirst = await translationCount(pool, target.chunkId);
    translator.clearCalls();

    const second = await runJob();
    const afterSecond = await translationCount(pool, target.chunkId);

    expect(afterFirst).toBe(before);
    expect(afterSecond).toBe(afterFirst);
    expect(second.translated).toBe(0);
    expect(second.pathFilled).toBe(0);
    expect(translator.calls).toHaveLength(0);
    expect(first.pathFilled).toBe(1);
  });

  it('[기준 8a] 경로 원소 번역 실패 시 실행 전 본문·원천 해시를 보존한다', async () => {
    const path = [
      'criterion-8a 합성 성공 경로 원소',
      'criterion-8a 합성 실패 경로 원소',
    ];
    const target = await seedPathOnly('criterion-8a', path);
    translator.failOn(path[1]);
    const before = await translationOf(pool, target.chunkId);

    await runJob();
    const after = await translationOf(pool, target.chunkId);

    expect(after.content).toBe(before.content);
    expect(after.source_content_hash).toBe(before.source_content_hash);
  });

  it('[기준 8b] 경로 원소 하나가 실패하면 부분 배열을 남기지 않고 NULL을 유지한다', async () => {
    const path = [
      'criterion-8b 합성 성공 경로 원소',
      'criterion-8b 합성 실패 경로 원소',
    ];
    const target = await seedPathOnly('criterion-8b', path);
    translator.failOn(path[1]);

    await runJob();
    const after = await translationOf(pool, target.chunkId);

    expect(after.section_path_translated).toBeNull();
    expect(translator.calls.map((call) => call.text)).not.toContain(
      target.content,
    );
  });

  it('[기준 8c] 경로 번역이 계속 실패해도 두 번째 실행에서 청크 본문을 다시 번역하지 않는다', async () => {
    const path = [
      'criterion-8c 합성 성공 경로 원소',
      'criterion-8c 합성 실패 경로 원소',
    ];
    const target = await seedPathOnly('criterion-8c', path);
    translator.failOn(path[1]);

    await runJob();
    translator.clearCalls();
    await runJob();

    expect(translator.calls.map((call) => call.text)).not.toContain(
      target.content,
    );
  });
});
