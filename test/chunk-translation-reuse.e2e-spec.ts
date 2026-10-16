// #535 작업 2-a 수용 기준 1~15 동결 테스트 — 구현 중 수정 금지

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
  lang: SupportedLang;
  sectionPathTranslated: string[] | null;
  sourceContentHash: string;
  translatorModel: string;
  translatedAt: string;
}

interface SeedChunk {
  id: string;
  content: string;
  contentHash: string;
  path: string[];
  translation?: SeedTranslation;
}

interface SeedVersion {
  key: string;
  version: string;
  revision: number;
  status: 'ACTIVE' | 'SUPERSEDED';
  chunks: SeedChunk[];
}

interface TranslationSnapshot {
  content: string;
  section_path_translated: string[] | null;
  translator_model: string;
  source_content_hash: string;
}

interface PairOptions {
  differentText?: boolean;
  staleOriginal?: boolean;
  originalLang?: SupportedLang;
  differentGuideline?: boolean;
  differentVersion?: boolean;
  differentPath?: boolean;
  outsideScope?: boolean;
  staleCandidate?: boolean;
  multipleOriginals?: boolean;
}

class RecordingTranslator implements Translator {
  readonly model = 'issue535-recording-translator-v1';
  readonly calls: Array<{ text: string; target: SupportedLang }> = [];

  translate(text: string, target: SupportedLang): Promise<string> {
    this.calls.push({ text, target });
    return Promise.resolve(`[${target}] ${text}`);
  }

  clearCalls(): void {
    this.calls.length = 0;
  }

  reset(): void {
    this.clearCalls();
  }
}

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

function translatedPath(path: readonly string[]): string[] {
  return path.map((segment) => `[en] ${segment}`);
}

async function seedGuideline(
  pool: Pool,
  key: string,
  title: string,
  versions: SeedVersion[],
): Promise<void> {
  const guidelineId = `issue535-guideline-${key}`;
  await pool.query(
    `INSERT INTO guidelines (id, title, publisher, status)
     VALUES ($1, $2, $3, 'ACTIVE')`,
    [guidelineId, title, `#535 ${key} 합성 발행처`],
  );

  for (const version of versions) {
    const versionId = `issue535-version-${key}-${version.key}`;
    await pool.query(
      `INSERT INTO guideline_versions
         (id, guideline_id, version, revision, status, published_at, source_url, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        versionId,
        guidelineId,
        version.version,
        version.revision,
        version.status,
        new Date('2026-08-31T00:00:00.000Z'),
        `https://example.test/issue535/${key}/${version.key}`,
        `issue535-document-hash-${key}-${version.key}`,
      ],
    );

    for (const [index, chunk] of version.chunks.entries()) {
      // 원본과 후보는 경로 값이 같더라도 반드시 서로 다른 섹션 행이다.
      const sectionId = `issue535-section-${chunk.id}`;
      await pool.query(
        `INSERT INTO guideline_sections
           (id, guideline_version_id, title, path, "order")
         VALUES ($1, $2, $3, $4, $5)`,
        [sectionId, versionId, `#535 ${chunk.id} 합성 섹션`, chunk.path, index + 1],
      );
      await pool.query(
        `INSERT INTO evidence_chunks
           (id, section_id, guideline_version_id, content, embedding, embedding_model,
            "order", content_hash)
         VALUES ($1, $2, $3, $4, $5::vector, 'fake-embedding-v1', $6, $7)`,
        [chunk.id, sectionId, versionId, chunk.content, EMBEDDING, index + 1, chunk.contentHash],
      );
      if (chunk.translation !== undefined) {
        const translation = chunk.translation;
        await pool.query(
          `INSERT INTO evidence_chunk_translations
             (id, chunk_id, lang, content, title_translated, section_path_translated,
              source_content_hash, translator_model, translated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            `issue535-translation-${chunk.id}-${translation.lang}`,
            chunk.id,
            translation.lang,
            translation.content,
            `${key} Preserved Synthetic Guideline`,
            translation.sectionPathTranslated,
            translation.sourceContentHash,
            translation.translatorModel,
            new Date(translation.translatedAt),
          ],
        );
      }
    }
  }
}

async function seedPair(pool: Pool, key: string, options: PairOptions = {}) {
  const path = [`${key} 합성 상위 경로`, `${key} 합성 하위 경로`];
  const originalTranslation: SeedTranslation = {
    content: `${key} Preserved adverse reactions translation`,
    lang: options.originalLang ?? 'en',
    sectionPathTranslated: [`${key} Reused parent`, `${key} Reused child`],
    sourceContentHash: `issue535-${key}-${options.staleOriginal ? 'obsolete' : 'original'}-hash`,
    translatorModel: `issue535-preserved-model-${key}`,
    translatedAt: '2026-01-01T00:00:00.000Z',
  };
  const original: SeedChunk = {
    id: `issue535-chunk-${key}-original`,
    content: `${key} 체중이 감소하였 다.\n허리둘레도`,
    contentHash: `issue535-${key}-original-hash`,
    path,
    translation: originalTranslation,
  };
  const candidate: SeedChunk = {
    id: `issue535-chunk-${key}-candidate`,
    content: `${key} 체중이 ${options.differentText ? '증소' : '감소'}하였다. 허리둘레도`,
    contentHash: `issue535-${key}-candidate-hash`,
    path: options.differentPath
      ? [`${key} 변경된 상위 경로`, `${key} 변경된 하위 경로`]
      : [...path],
  };
  if (options.staleCandidate) {
    candidate.translation = {
      ...originalTranslation,
      content: `${key} Obsolete candidate translation`,
      sourceContentHash: `issue535-${key}-obsolete-candidate-hash`,
    };
  }
  const oldVersion: SeedVersion = {
    key: 'old', version: '1.0', revision: 1, status: 'SUPERSEDED', chunks: [original],
  };
  const currentVersion: SeedVersion = {
    key: 'current', version: options.differentVersion ? '2.0' : '1.0',
    revision: 2, status: 'ACTIVE', chunks: [candidate],
  };
  let expectedOriginal = originalTranslation;
  if (options.multipleOriginals) {
    expectedOriginal = {
      ...originalTranslation,
      content: `${key} Latest preserved adverse reactions translation`,
      sourceContentHash: `issue535-${key}-newer-original-hash`,
      translatedAt: '2026-02-01T00:00:00.000Z',
    };
    // 최신 원본을 먼저 넣어 삽입 순서의 마지막 행 선택과 구별한다.
    oldVersion.chunks.unshift({
      id: `issue535-chunk-${key}-newer-original`,
      content: `${key} 체중이\n감소하였다.허리둘레도`,
      contentHash: `issue535-${key}-newer-original-hash`,
      path: [...path],
      translation: expectedOriginal,
    });
  }
  const title = `${options.outsideScope ? '비만' : '불면장애'} ${key} 합성 지침`;
  if (options.differentGuideline) {
    await seedGuideline(pool, `${key}-source`, `편두통 ${key} 원본 지침`, [oldVersion]);
    await seedGuideline(pool, key, title, [currentVersion]);
  } else {
    await seedGuideline(pool, key, title, [oldVersion, currentVersion]);
  }
  return { candidate, original: expectedOriginal };
}

async function translationOf(pool: Pool, chunkId: string): Promise<TranslationSnapshot> {
  const result = await pool.query<TranslationSnapshot>(
    `SELECT content, section_path_translated, translator_model, source_content_hash
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

describe('#535 작업 2-a: 공백만 다른 청크의 기존 번역 재사용', () => {
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

  it('[기준 1] 공백만 다른 후보 본문에 원본 번역을 재사용한다', async () => {
    const pair = await seedPair(pool, 'criterion-1');
    await runJob();
    expect((await translationOf(pool, pair.candidate.id)).content).toBe(pair.original.content);
  });

  it('[기준 2] 재사용 후보의 본문을 번역기에 보내지 않는다', async () => {
    const pair = await seedPair(pool, 'criterion-2');
    await runJob();
    expect(translator.calls.map((call) => call.text)).not.toContain(pair.candidate.content);
  });

  it('[기준 3] stale 후보를 재사용으로 갱신할 때 후보의 현재 해시를 기록한다', async () => {
    const pair = await seedPair(pool, 'criterion-3', { staleCandidate: true });
    const result = await runJob();
    // 양성 대조 — 스텁은 reused = 0이므로 본 단언 전에 실패한다.
    expect(result.reused).toBe(1);
    const after = await translationOf(pool, pair.candidate.id);
    expect(after.content).toBe(pair.original.content);
    expect(after.source_content_hash).toBe(pair.candidate.contentHash);
  });

  it('[기준 4] 재사용 원본 번역의 모델을 기록한다', async () => {
    const pair = await seedPair(pool, 'criterion-4');
    await runJob();
    expect((await translationOf(pool, pair.candidate.id)).translator_model).toBe(pair.original.translatorModel);
  });

  it('[기준 5a] 원문 경로가 같으면 원본의 번역 경로를 복사한다', async () => {
    const pair = await seedPair(pool, 'criterion-5a');
    await runJob();
    expect((await translationOf(pool, pair.candidate.id)).section_path_translated)
      .toEqual(pair.original.sectionPathTranslated);
  });

  it('[기준 5b] 원문 경로가 같으면 경로 원소를 번역기에 보내지 않는다', async () => {
    const pair = await seedPair(pool, 'criterion-5b');
    await runJob();
    const texts = translator.calls.map((call) => call.text);
    for (const segment of pair.candidate.path) {
      expect(texts).not.toContain(segment);
    }
  });

  it('[기준 6a] 원문 경로가 다르면 후보 경로를 길이와 순서대로 번역한다', async () => {
    const pair = await seedPair(pool, 'criterion-6a', { differentPath: true });
    const result = await runJob();
    // 양성 대조 — 경로를 번역하더라도 본문은 재사용되어야 한다.
    expect(result.reused).toBe(1);
    const after = await translationOf(pool, pair.candidate.id);
    expect(after.content).toBe(pair.original.content);
    expect(after.section_path_translated).toEqual(translatedPath(pair.candidate.path));
  });

  it('[기준 6b] 원문 경로가 달라도 본문은 원본 번역을 재사용한다', async () => {
    const pair = await seedPair(pool, 'criterion-6b', { differentPath: true });
    await runJob();
    expect((await translationOf(pool, pair.candidate.id)).content).toBe(pair.original.content);
  });

  it('[기준 7a] 재사용으로 쓴 한 행을 reused에 센다', async () => {
    await seedPair(pool, 'criterion-7a');
    expect((await runJob()).reused).toBe(1);
  });

  it('[기준 7b] 재사용 한 건과 신규 번역 한 건을 분리해 센다', async () => {
    await seedPair(pool, 'criterion-7b-reuse');
    await seedPair(pool, 'criterion-7b-translate', { differentText: true });
    const result = await runJob();
    expect(result.translated).toBe(1);
    expect(result.reused).toBe(1);
  });

  it('[기준 8] 공백 외의 글자가 다르면 후보 본문을 새로 번역한다', async () => {
    const control = await seedPair(pool, 'criterion-8-control');
    const pair = await seedPair(pool, 'criterion-8', { differentText: true });
    const result = await runJob();
    expect(result.reused).toBe(1);
    expect((await translationOf(pool, control.candidate.id)).content).toBe(control.original.content);
    expect((await translationOf(pool, pair.candidate.id)).content).toBe(`[en] ${pair.candidate.content}`);
  });

  it('[기준 9] 원본의 번역 행이 stale이면 재사용하지 않는다', async () => {
    const control = await seedPair(pool, 'criterion-9-control');
    const pair = await seedPair(pool, 'criterion-9', { staleOriginal: true });
    const result = await runJob();
    expect(result.reused).toBe(1);
    expect((await translationOf(pool, control.candidate.id)).content).toBe(control.original.content);
    expect((await translationOf(pool, pair.candidate.id)).content).toBe(`[en] ${pair.candidate.content}`);
  });

  it('[기준 10] 원본에 대상 언어가 아닌 번역만 있으면 재사용하지 않는다', async () => {
    const control = await seedPair(pool, 'criterion-10-control');
    const pair = await seedPair(pool, 'criterion-10', { originalLang: 'ko' });
    const result = await runJob();
    expect(result.reused).toBe(1);
    expect((await translationOf(pool, control.candidate.id)).content).toBe(control.original.content);
    expect((await translationOf(pool, pair.candidate.id)).content).toBe(`[en] ${pair.candidate.content}`);
  });

  it('[기준 11] 다른 지침의 같은 본문 번역은 재사용하지 않는다', async () => {
    const control = await seedPair(pool, 'criterion-11-control');
    const pair = await seedPair(pool, 'criterion-11', { differentGuideline: true });
    const result = await runJob();
    expect(result.reused).toBe(1);
    expect((await translationOf(pool, control.candidate.id)).content).toBe(control.original.content);
    expect((await translationOf(pool, pair.candidate.id)).content).toBe(`[en] ${pair.candidate.content}`);
  });

  it('[기준 12] 같은 지침의 다른 판본 번역은 재사용하지 않는다', async () => {
    const control = await seedPair(pool, 'criterion-12-control');
    const pair = await seedPair(pool, 'criterion-12', { differentVersion: true });
    const result = await runJob();
    expect(result.reused).toBe(1);
    expect((await translationOf(pool, control.candidate.id)).content).toBe(control.original.content);
    expect((await translationOf(pool, pair.candidate.id)).content).toBe(`[en] ${pair.candidate.content}`);
  });

  it('[기준 13] 원본이 여럿이면 translated_at이 가장 늦은 번역을 쓴다', async () => {
    const pair = await seedPair(pool, 'criterion-13', { multipleOriginals: true });
    await runJob();
    expect((await translationOf(pool, pair.candidate.id)).content).toBe(pair.original.content);
  });

  it('[기준 14] demo 범위 밖 후보에는 재사용 번역 행을 만들지 않는다', async () => {
    const control = await seedPair(pool, 'criterion-14-control');
    const pair = await seedPair(pool, 'criterion-14', { outsideScope: true });
    const result = await runJob();
    expect(result.reused).toBe(1);
    expect((await translationOf(pool, control.candidate.id)).content).toBe(control.original.content);
    expect(await translationCount(pool, pair.candidate.id)).toBe(0);
  });

  it('[기준 15a] 재사용 후 두 번째 실행의 reused와 translated는 모두 0이다', async () => {
    const pair = await seedPair(pool, 'criterion-15a');
    const first = await runJob();
    expect(first.reused).toBe(1);
    expect((await translationOf(pool, pair.candidate.id)).content).toBe(pair.original.content);
    const second = await runJob();
    expect(second.reused).toBe(0);
    expect(second.translated).toBe(0);
  });

  it('[기준 15b] 재사용 후 두 번째 실행에는 번역기를 호출하지 않는다', async () => {
    const pair = await seedPair(pool, 'criterion-15b');
    const first = await runJob();
    expect(first.reused).toBe(1);
    expect((await translationOf(pool, pair.candidate.id)).content).toBe(pair.original.content);
    translator.clearCalls();
    await runJob();
    expect(translator.calls).toHaveLength(0);
  });
});
