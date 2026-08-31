// docs/specs/44 BE 수용 기준 1·4·5·6·7·8·10·11·12·14·16·18·19·20·21·23·24 동결 테스트 — 구현 중 수정 금지

import { randomUUID } from 'node:crypto';
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
import { ChunkTranslatorService } from '../src/domain/guideline/service/chunk-translator.service';
import { retrievalConfig } from '../src/global/config/retrieval.config';
import {
  GUIDANCE_STRUCTURER,
  type GuidanceStructureRequest,
  type GuidanceStructureResult,
  type GuidanceStructurer,
} from '../src/infrastructure/llm/guidance/guidance-structurer.port';
import {
  LLM_PROVIDERS,
  type LlmAnswerChunk,
  type LlmProvider,
  type LlmStreamRequest,
} from '../src/infrastructure/llm/llm-provider.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import {
  TRANSLATOR,
  type SupportedLang,
  type Translator,
} from '../src/infrastructure/llm/translation/translator.port';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { socialSignUp } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };
const EMBEDDING = `[${Array.from({ length: 1536 }, () => '0.001').join(',')}]`;

const PRIMARY_GUIDELINE_ID = 'spec44-guideline-primary';
const PRIMARY_VERSION_ID = 'spec44-version-primary';
const PRIMARY_SECTION_ID = 'spec44-section-primary';
const PRIMARY_CHUNK_ID = 'spec44-chunk-primary';
const PRIMARY_HASH = 'spec44-primary-hash-v1';
const PRIMARY_TITLE_KO = '만성 요통 합성 진료지침';
const PRIMARY_TITLE_EN = 'Synthetic Chronic Low Back Pain Guideline';
const PRIMARY_PATH_KO = ['Ⅳ. 권고사항', '1. 합성 침 치료'];
const PRIMARY_PATH_EN = ['IV. Recommendations', '1. Synthetic acupuncture treatment'];
const PRIMARY_CONTENT =
  '만성 요통과 합성 침 치료 권고를 설명하는 테스트 전용 근거 문장입니다.';
const PRIMARY_TRANSLATION =
  'This synthetic recommendation describes acupuncture treatment for chronic low back pain.';
const PRIMARY_TRANSLATOR_MODEL = 'spec44-seeded-translator-v1';

const MISSING_GUIDELINE_ID = 'spec44-guideline-missing';
const MISSING_VERSION_ID = 'spec44-version-missing';
const MISSING_SECTION_ID = 'spec44-section-missing';
const MISSING_CHUNK_ID = 'spec44-chunk-missing';

const STALE_GUIDELINE_ID = 'spec44-guideline-stale';
const STALE_VERSION_ID = 'spec44-version-stale';
const STALE_SECTION_ID = 'spec44-section-stale';
const STALE_CHUNK_ID = 'spec44-chunk-stale';
const STALE_HASH = 'spec44-stale-current-hash';

const NULL_PATH_GUIDELINE_ID = 'spec44-guideline-null-path';
const NULL_PATH_VERSION_ID = 'spec44-version-null-path';
const NULL_PATH_SECTION_ID = 'spec44-section-null-path';
const NULL_PATH_CHUNK_ID = 'spec44-chunk-null-path';
const NULL_PATH_HASH = 'spec44-null-path-hash-v1';

const JOB_GUIDELINE_ID = 'spec44-guideline-job';
const JOB_VERSION_ID = 'spec44-version-job';
const JOB_SECTION_ID = 'spec44-section-job';
const JOB_BASE_CHUNK_ID = 'spec44-chunk-job-base';
const JOB_PATH_KO = ['Ⅱ. 합성 치료', '3. 번역 잡 검증'];

const EN_QUESTION =
  'What does the synthetic guideline recommend for chronic low back pain?';
const KO_QUESTION = '합성 만성 요통 지침의 권고를 알려 주세요.';
const TRANSLATED_QUERY = '합성 만성 요통 지침 권고 검색어';
const EN_ANSWER = 'The synthetic evidence supports a cautious clinical review [1].';
const KO_ANSWER = '합성 근거를 환자 상태와 함께 신중히 검토하세요 [1].';
const EN_ALLERGEN = 'synthetic pollen';

interface SseEvent {
  eventType: string;
  [key: string]: unknown;
}

interface GuidanceDto {
  id: string;
  considerations: Array<{
    title: string;
    rationale: string;
    citations: Array<Record<string, unknown>>;
  }>;
  safetyAlerts: Array<{
    severity: string;
    description: string;
    citations: Array<Record<string, unknown>>;
  }>;
  [key: string]: unknown;
}

interface FixtureGuideline {
  guidelineId: string;
  versionId: string;
  sectionId: string;
  chunkId: string;
  title: string;
  sectionPath: string[];
  content: string;
  contentHash: string;
  recommendationNumber?: string;
}

const FIXTURE_GUIDELINES: FixtureGuideline[] = [
  {
    guidelineId: PRIMARY_GUIDELINE_ID,
    versionId: PRIMARY_VERSION_ID,
    sectionId: PRIMARY_SECTION_ID,
    chunkId: PRIMARY_CHUNK_ID,
    title: PRIMARY_TITLE_KO,
    sectionPath: PRIMARY_PATH_KO,
    content: PRIMARY_CONTENT,
    contentHash: PRIMARY_HASH,
    recommendationNumber: 'SYN-R1',
  },
  {
    guidelineId: MISSING_GUIDELINE_ID,
    versionId: MISSING_VERSION_ID,
    sectionId: MISSING_SECTION_ID,
    chunkId: MISSING_CHUNK_ID,
    title: '합성 무번역 진료지침',
    sectionPath: ['Ⅰ. 합성 근거', '1. 번역 없음'],
    content: '번역 행이 없는 합성 근거 전문입니다.',
    contentHash: 'spec44-missing-hash-v1',
  },
  {
    guidelineId: STALE_GUIDELINE_ID,
    versionId: STALE_VERSION_ID,
    sectionId: STALE_SECTION_ID,
    chunkId: STALE_CHUNK_ID,
    title: '합성 낡은 번역 진료지침',
    sectionPath: ['Ⅰ. 합성 근거', '2. 낡은 번역'],
    content: '현재 해시와 번역 원천 해시가 다른 합성 근거 전문입니다.',
    contentHash: STALE_HASH,
  },
  {
    guidelineId: NULL_PATH_GUIDELINE_ID,
    versionId: NULL_PATH_VERSION_ID,
    sectionId: NULL_PATH_SECTION_ID,
    chunkId: NULL_PATH_CHUNK_ID,
    title: '합성 경로 미번역 진료지침',
    sectionPath: ['Ⅰ. 합성 근거', '3. 경로 번역 없음'],
    content: '본문 번역은 있지만 섹션 경로 번역은 null인 합성 근거입니다.',
    contentHash: NULL_PATH_HASH,
  },
  {
    guidelineId: JOB_GUIDELINE_ID,
    versionId: JOB_VERSION_ID,
    sectionId: JOB_SECTION_ID,
    chunkId: JOB_BASE_CHUNK_ID,
    title: '편두통 합성 번역 잡 진료지침',
    sectionPath: JOB_PATH_KO,
    content: '섹션 경로 번역 잡을 검증하는 최초 합성 청크입니다.',
    contentHash: 'spec44-job-base-hash-v1',
  },
];

class DeterministicTranslator implements Translator {
  readonly model = 'spec44-deterministic-translator-v1';
  readonly calls: Array<{ text: string; target: SupportedLang }> = [];

  translate(text: string, target: SupportedLang): Promise<string> {
    this.calls.push({ text, target });
    return Promise.resolve(
      target === 'ko' ? TRANSLATED_QUERY : `[en] ${text}`,
    );
  }
}

class LanguageAwareAnswerProvider implements LlmProvider {
  readonly name = 'spec44-answer-provider';
  readonly model = 'spec44-answer-model-v1';

  async *streamAnswer(requestValue: LlmStreamRequest): AsyncIterable<LlmAnswerChunk> {
    const responseLang = (
      requestValue as LlmStreamRequest & { responseLang?: SupportedLang }
    ).responseLang;
    yield {
      kind: 'delta',
      text: responseLang === 'en' ? EN_ANSWER : KO_ANSWER,
    };
  }
}

class DeterministicGuidanceStructurer implements GuidanceStructurer {
  readonly model = 'spec44-guidance-structurer-v1';
  readonly requests: GuidanceStructureRequest[] = [];

  structure(requestValue: GuidanceStructureRequest): Promise<GuidanceStructureResult> {
    this.requests.push(requestValue);
    const evidence = requestValue.evidence[0];
    const patientFactor = requestValue.profileFields[0]?.field;
    if (!evidence || !patientFactor) {
      return Promise.resolve({ considerations: [] });
    }

    const english = requestValue.lang === 'en';
    return Promise.resolve({
      considerations: [
        {
          title: english
            ? 'Synthetic patient-specific consideration'
            : '합성 환자 맞춤 검토 항목',
          rationale: english
            ? 'Compare the cited synthetic evidence with the recorded patient factor.'
            : '인용한 합성 근거를 기록된 환자 항목과 대조합니다.',
          applicability: 'CAUTION',
          markers: [evidence.marker],
          patientFactors: [patientFactor],
        },
      ],
    });
  }
}

class ThrowingGuidanceStructurer implements GuidanceStructurer {
  readonly model = 'spec44-throwing-guidance-structurer-v1';

  structure(): Promise<GuidanceStructureResult> {
    return Promise.reject(
      new Error('spec44 deterministic guidance structurer failure'),
    );
  }
}

function parseSse(raw: string): SseEvent[] {
  return raw
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => frame.split(/\r?\n/))
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as SseEvent);
}

function eventOf(events: SseEvent[], eventType: string): SseEvent {
  const event = events.find((candidate) => candidate.eventType === eventType);
  if (!event) throw new Error(`${eventType} 이벤트가 없습니다.`);
  return event;
}

function guidanceOf(events: SseEvent[]): GuidanceDto {
  const guidance = eventOf(events, 'answer.completed').guidance;
  if (!guidance || typeof guidance !== 'object' || Array.isArray(guidance)) {
    throw new Error('answer.completed에 guidance 객체가 없습니다.');
  }
  return guidance as GuidanceDto;
}

function retrievalEvidenceOf(events: SseEvent[]): Array<Record<string, unknown>> {
  const evidence = eventOf(events, 'retrieval.completed').evidence;
  if (!Array.isArray(evidence)) {
    throw new Error('retrieval.completed evidence가 배열이 아닙니다.');
  }
  return evidence as Array<Record<string, unknown>>;
}

function evidenceItemOf(
  evidence: Array<Record<string, unknown>>,
  evidenceId: string,
): Record<string, unknown> {
  const item = evidence.find(
    (candidate) =>
      candidate.id === evidenceId ||
      candidate.evidenceId === evidenceId ||
      candidate.chunkId === evidenceId,
  );
  if (!item) throw new Error(`${evidenceId} 근거가 없습니다.`);
  return item;
}

function messageCollectionOf(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== 'object') {
    throw new Error('메시지 응답 body가 객체가 아닙니다.');
  }
  const data = (body as Record<string, unknown>).data;
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === 'object') {
    for (const key of ['items', 'messages']) {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
    }
  }
  throw new Error('메시지 목록 배열이 없습니다.');
}

function citationsOfMessage(
  message: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (!Array.isArray(message.citations)) {
    throw new Error('message.citations가 배열이 아닙니다.');
  }
  return message.citations as Array<Record<string, unknown>>;
}

function assistantMessageOf(
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const message = messages.find((candidate) => candidate.role === 'ASSISTANT');
  if (!message) throw new Error('assistant 메시지가 없습니다.');
  return message;
}

function firstGuidanceCitation(guidance: GuidanceDto): Record<string, unknown> {
  const citation = guidance.considerations[0]?.citations[0];
  if (!citation) throw new Error('참고안 첫 검토 항목에 인용이 없습니다.');
  return citation;
}

function expectKeysAbsent(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    expect(key in value).toBe(false);
  }
}

function expectEnglish(value: unknown): void {
  expect(typeof value).toBe('string');
  expect(value as string).toMatch(/[A-Za-z]/);
  expect(value as string).not.toMatch(/[가-힣]/);
}

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

async function seedCorpus(pool: Pool): Promise<void> {
  for (const fixture of FIXTURE_GUIDELINES) {
    await pool.query(
      `INSERT INTO guidelines (id, title, publisher, status)
       VALUES ($1, $2, 'spec44 합성 발행처', 'ACTIVE')`,
      [fixture.guidelineId, fixture.title],
    );
    await pool.query(
      `INSERT INTO guideline_versions
         (id, guideline_id, version, revision, status, published_at, source_url, content_hash)
       VALUES ($1, $2, '1.0', 1, 'ACTIVE', $3, $4, $5)`,
      [
        fixture.versionId,
        fixture.guidelineId,
        new Date('2026-08-31T00:00:00.000Z'),
        `https://example.test/source/${fixture.guidelineId}`,
        `${fixture.contentHash}-document`,
      ],
    );
    await pool.query(
      `INSERT INTO guideline_sections
         (id, guideline_version_id, title, path, "order")
       VALUES ($1, $2, '합성 섹션', $3, 1)`,
      [fixture.sectionId, fixture.versionId, fixture.sectionPath],
    );
    await pool.query(
      `INSERT INTO evidence_chunks
         (id, section_id, guideline_version_id, content, embedding, embedding_model,
          recommendation_number, "order", content_hash)
       VALUES ($1, $2, $3, $4, $5::vector, 'fake-embedding-v1', $6, 1, $7)`,
      [
        fixture.chunkId,
        fixture.sectionId,
        fixture.versionId,
        fixture.content,
        EMBEDDING,
        fixture.recommendationNumber ?? null,
        fixture.contentHash,
      ],
    );
  }

  await pool.query(
    `INSERT INTO evidence_chunk_translations
       (id, chunk_id, lang, content, title_translated, section_path_translated,
        source_content_hash, translator_model)
     VALUES ($1, $2, 'en', $3, $4, $5, $6, $7)`,
    [
      'spec44-translation-primary-en',
      PRIMARY_CHUNK_ID,
      PRIMARY_TRANSLATION,
      PRIMARY_TITLE_EN,
      PRIMARY_PATH_EN,
      PRIMARY_HASH,
      PRIMARY_TRANSLATOR_MODEL,
    ],
  );
  await pool.query(
    `INSERT INTO evidence_chunk_translations
       (id, chunk_id, lang, content, title_translated, section_path_translated,
        source_content_hash, translator_model)
     VALUES ($1, $2, 'en', $3, $4, $5, 'spec44-obsolete-hash', 'spec44-stale-model')`,
    [
      'spec44-translation-stale-en',
      STALE_CHUNK_ID,
      'Obsolete synthetic evidence translation.',
      'Obsolete Synthetic Guideline',
      ['I. Obsolete evidence', '2. Stale translation'],
    ],
  );
  await pool.query(
    `INSERT INTO evidence_chunk_translations
       (id, chunk_id, lang, content, title_translated, section_path_translated,
        source_content_hash, translator_model)
     VALUES ($1, $2, 'en', $3, $4, NULL, $5, 'spec44-null-path-model')`,
    [
      'spec44-translation-null-path-en',
      NULL_PATH_CHUNK_ID,
      'Synthetic evidence with a translated body but no translated section path.',
      'Synthetic Guideline Without a Translated Path',
      NULL_PATH_HASH,
    ],
  );
}

describe('spec 44: 참고안·근거 응답 언어 BE 수용 계약', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let structuredApp: INestApplication;
  let fallbackApp: INestApplication;
  let structuredCookie: string;
  let fallbackCookie: string;

  let englishConversationId: string;
  let koreanConversationId: string;
  let englishEvents: SseEvent[];
  let koreanEvents: SseEvent[];
  let fallbackEvents: SseEvent[];
  let englishGuidance: GuidanceDto;
  let koreanGuidance: GuidanceDto;
  let fallbackGuidance: GuidanceDto;

  const translator = new DeterministicTranslator();
  const answerProvider = new LanguageAwareAnswerProvider();
  const structuredGuidance = new DeterministicGuidanceStructurer();
  const throwingGuidance = new ThrowingGuidanceStructurer();

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const originalAnswerabilityGate = process.env.LLM_ANSWERABILITY_GATE_ENABLED;

  const createApp = async (
    structurer: GuidanceStructurer,
  ): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(TRANSLATOR)
      .useValue(translator)
      .overrideProvider(LLM_PROVIDERS)
      .useValue([answerProvider])
      .overrideProvider(GUIDANCE_STRUCTURER)
      .useValue(structurer)
      .overrideProvider(retrievalConfig.KEY)
      .useValue({
        distanceCutoff: 2,
        rerankEnabled: false,
        rerankCandidates: 30,
        rerankScoreCutoff: 6,
        hybridEnabled: true,
      })
      .compile();

    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);
    return app;
  };

  const createPatient = async (
    app: INestApplication,
    cookie: string,
    label: string,
    allergies: string[],
  ): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({
        caseLabel: label,
        birthYear: 1980,
        sex: 'FEMALE',
        heightCm: 165,
        weightKg: 60,
        waistCm: 75,
        diagnoses: ['합성 만성 요통'],
        medications: [],
        allergies,
        clinicalNotes: 'spec 44 합성 임상 메모',
      })
      .expect(201);
    const id = response.body.data.id;
    if (typeof id !== 'string') throw new Error('환자 id가 문자열이 아닙니다.');
    return id;
  };

  const createConversation = async (
    app: INestApplication,
    cookie: string,
    patientId: string,
  ): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ type: 'PATIENT_GUIDANCE', patientId })
      .expect(201);
    const id = response.body.data.id;
    if (typeof id !== 'string') throw new Error('대화 id가 문자열이 아닙니다.');
    return id;
  };

  const streamGuidance = async (
    app: INestApplication,
    cookie: string,
    conversationId: string,
    content: string,
    responseLang?: SupportedLang,
  ): Promise<SseEvent[]> => {
    const body: Record<string, unknown> = {
      content,
      clientRequestId: randomUUID(),
      filters: { guidelineIds: [PRIMARY_GUIDELINE_ID] },
    };
    if (responseLang !== undefined) body.responseLang = responseLang;

    const response = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', cookie)
      .send(body)
      .expect(200);
    if (!String(response.headers['content-type']).includes('text/event-stream')) {
      throw new Error('스트림 응답이 text/event-stream이 아닙니다.');
    }
    return parseSse(response.text);
  };

  const getEvidence = async (
    evidenceId: string,
    lang?: SupportedLang,
  ): Promise<Record<string, unknown>> => {
    const pending = request(structuredApp.getHttpServer())
      .get(`/api/v1/evidence/${evidenceId}`)
      .set('Cookie', structuredCookie);
    const response = await (lang === undefined
      ? pending
      : pending.query({ lang })
    ).expect(200);
    return response.body.data as Record<string, unknown>;
  };

  const getGuidelineItems = async (
    lang: SupportedLang,
  ): Promise<Array<Record<string, unknown>>> => {
    const response = await request(structuredApp.getHttpServer())
      .get('/api/v1/guidelines')
      .query({ lang, size: 50 })
      .set('Cookie', structuredCookie)
      .expect(200);
    if (!Array.isArray(response.body.data)) {
      throw new Error('지침 목록 data가 배열이 아닙니다.');
    }
    return response.body.data as Array<Record<string, unknown>>;
  };

  const getMessages = async (
    app: INestApplication,
    cookie: string,
    conversationId: string,
  ): Promise<Array<Record<string, unknown>>> => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set('Cookie', cookie)
      .expect(200);
    return messageCollectionOf(response.body);
  };

  const getGuidance = async (
    app: INestApplication,
    cookie: string,
    guidanceId: string,
  ): Promise<GuidanceDto> => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/clinical-guidance/${guidanceId}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body.data as GuidanceDto;
  };

  const composerVersionOf = async (guidanceId: string): Promise<string> => {
    const result = await pool.query<{ composer_version: string }>(
      'SELECT composer_version FROM clinical_guidances WHERE id = $1',
      [guidanceId],
    );
    if (result.rows.length !== 1) throw new Error('참고안 DB 행이 없습니다.');
    return result.rows[0].composer_version;
  };

  let jobOrder = 10;
  const insertJobChunk = async (): Promise<{ id: string; path: string[] }> => {
    jobOrder += 1;
    const id = `spec44-job-${randomUUID()}`;
    const contentHash = `spec44-job-hash-${randomUUID()}`;
    await pool.query(
      `INSERT INTO evidence_chunks
         (id, section_id, guideline_version_id, content, embedding, embedding_model,
          "order", content_hash)
       VALUES ($1, $2, $3, $4, $5::vector, 'fake-embedding-v1', $6, $7)`,
      [
        id,
        JOB_SECTION_ID,
        JOB_VERSION_ID,
        `섹션 경로 번역 잡 합성 청크 ${id}`,
        EMBEDDING,
        jobOrder,
        contentHash,
      ],
    );
    return { id, path: JOB_PATH_KO };
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
    await seedCorpus(pool);

    structuredApp = await createApp(structuredGuidance);
    fallbackApp = await createApp(throwingGuidance);

    structuredCookie = (
      await socialSignUp(structuredApp, {
        email: 'spec44-structured@clinic.kr',
        clinicName: 'spec44 구조화 합성 한의원',
        licenseNumber: 'LIC-SPEC44-1',
      })
    ).cookie;
    fallbackCookie = (
      await socialSignUp(fallbackApp, {
        email: 'spec44-fallback@clinic.kr',
        clinicName: 'spec44 폴백 합성 한의원',
        licenseNumber: 'LIC-SPEC44-2',
      })
    ).cookie;

    const englishPatientId = await createPatient(
      structuredApp,
      structuredCookie,
      'SPEC44-EN',
      [EN_ALLERGEN],
    );
    englishConversationId = await createConversation(
      structuredApp,
      structuredCookie,
      englishPatientId,
    );
    englishEvents = await streamGuidance(
      structuredApp,
      structuredCookie,
      englishConversationId,
      EN_QUESTION,
      'en',
    );
    englishGuidance = guidanceOf(englishEvents);

    const koreanPatientId = await createPatient(
      structuredApp,
      structuredCookie,
      'SPEC44-KO',
      [],
    );
    koreanConversationId = await createConversation(
      structuredApp,
      structuredCookie,
      koreanPatientId,
    );
    koreanEvents = await streamGuidance(
      structuredApp,
      structuredCookie,
      koreanConversationId,
      KO_QUESTION,
    );
    koreanGuidance = guidanceOf(koreanEvents);

    const fallbackPatientId = await createPatient(
      fallbackApp,
      fallbackCookie,
      'SPEC44-FALLBACK',
      [],
    );
    const fallbackConversationId = await createConversation(
      fallbackApp,
      fallbackCookie,
      fallbackPatientId,
    );
    fallbackEvents = await streamGuidance(
      fallbackApp,
      fallbackCookie,
      fallbackConversationId,
      EN_QUESTION,
      'en',
    );
    fallbackGuidance = guidanceOf(fallbackEvents);
  });

  afterAll(async () => {
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('REDIS_URL', originalRedisUrl);
    restoreEnv('OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnv('ANTHROPIC_API_KEY', originalAnthropicApiKey);
    restoreEnv('LLM_ANSWERABILITY_GATE_ENABLED', originalAnswerabilityGate);

    await fallbackApp?.close();
    await structuredApp?.close();
    await pool?.end();
    await Promise.all([
      postgresContainer?.stop(),
      redisContainer?.stop(),
    ]);
  });

  it('[기준 1] lang 없는 근거 상세은 번역 행이 있어도 번역 키가 하나도 없다', async () => {
    const seeded = await pool.query(
      'SELECT 1 FROM evidence_chunk_translations WHERE chunk_id = $1 AND lang = $2',
      [PRIMARY_CHUNK_ID, 'en'],
    );
    expect(seeded.rows).toHaveLength(1);

    const detail = await getEvidence(PRIMARY_CHUNK_ID);
    expect(detail.id).toBe(PRIMARY_CHUNK_ID);
    expectKeysAbsent(detail, [
      'excerptTranslated',
      'titleTranslated',
      'translationModel',
      'recommendationTextTranslated',
      'sectionPathTranslated',
    ]);
  });

  it('[기준 4a] lang=en 근거 상세은 적재한 excerptTranslated를 싣는다', async () => {
    const detail = await getEvidence(PRIMARY_CHUNK_ID, 'en');

    expect(detail.excerptTranslated).toBe(PRIMARY_TRANSLATION);
  });

  it('[기준 4b] lang=en 근거 상세은 적재한 translator_model을 provenance로 싣는다', async () => {
    const detail = await getEvidence(PRIMARY_CHUNK_ID, 'en');

    expect(detail.translationModel).toBe(PRIMARY_TRANSLATOR_MODEL);
  });

  it('[기준 5] 권고 청크의 recommendationTextTranslated는 excerptTranslated와 같은 문자열이다', async () => {
    const detail = await getEvidence(PRIMARY_CHUNK_ID, 'en');

    expect(detail.recommendationNumber).toBe('SYN-R1');
    expect(detail.excerptTranslated).toBe(PRIMARY_TRANSLATION);
    expect(detail.recommendationTextTranslated).toBe(
      detail.excerptTranslated,
    );
  });

  it('[기준 6] 번역 행이 없는 청크는 모든 번역 키를 생략한다', async () => {
    const translatedControl = await getEvidence(PRIMARY_CHUNK_ID, 'en');
    const untranslated = await getEvidence(MISSING_CHUNK_ID, 'en');

    expect(translatedControl.excerptTranslated).toBe(PRIMARY_TRANSLATION);
    expect(translatedControl.sectionPathTranslated).toEqual(PRIMARY_PATH_EN);
    expectKeysAbsent(untranslated, [
      'excerptTranslated',
      'translationModel',
      'sectionPathTranslated',
      'recommendationTextTranslated',
    ]);
  });

  it('[기준 7] source_content_hash가 현재 content_hash와 다르면 번역 키를 싣지 않는다', async () => {
    const translatedControl = await getEvidence(PRIMARY_CHUNK_ID, 'en');
    const stale = await getEvidence(STALE_CHUNK_ID, 'en');

    expect(translatedControl.excerptTranslated).toBe(PRIMARY_TRANSLATION);
    expectKeysAbsent(stale, [
      'excerptTranslated',
      'titleTranslated',
      'translationModel',
      'sectionPathTranslated',
      'recommendationTextTranslated',
    ]);
  });

  it('[기준 8a] lang=en 지침 목록은 번역 행이 있는 지침의 titleTranslated를 싣는다', async () => {
    const items = await getGuidelineItems('en');
    const translated = items.find((item) => item.id === PRIMARY_GUIDELINE_ID);

    expect(translated).toBeDefined();
    expect(translated?.titleTranslated).toBe(PRIMARY_TITLE_EN);
  });

  it('[기준 8b] lang=en 지침 목록은 번역이 없는 지침의 titleTranslated 키를 생략한다', async () => {
    const items = await getGuidelineItems('en');
    const translatedControl = items.find(
      (item) => item.id === PRIMARY_GUIDELINE_ID,
    );
    const untranslated = items.find(
      (item) => item.id === MISSING_GUIDELINE_ID,
    );

    expect(translatedControl?.titleTranslated).toBe(PRIMARY_TITLE_EN);
    expect(untranslated).toBeDefined();
    expect('titleTranslated' in (untranslated as Record<string, unknown>)).toBe(
      false,
    );
  });

  it('[기준 10a] 번역 잡은 대상 청크 행의 section_path_translated를 채운다', async () => {
    const target = await insertJobChunk();

    await structuredApp
      .get(ChunkTranslatorService)
      .translatePending({ scope: 'demo', target: 'en' });
    const result = await pool.query<{ section_path_translated: string[] | null }>(
      `SELECT section_path_translated
       FROM evidence_chunk_translations
       WHERE chunk_id = $1 AND lang = 'en'`,
      [target.id],
    );

    expect(result.rows).toEqual([
      {
        section_path_translated: target.path.map((segment) => `[en] ${segment}`),
      },
    ]);
  });

  it('[기준 10b] 같은 번역 잡을 두 번 돌려도 행이 늘지 않고 경로 번역이 보존된다', async () => {
    const target = await insertJobChunk();
    const before = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM evidence_chunk_translations',
    );

    await structuredApp
      .get(ChunkTranslatorService)
      .translatePending({ scope: 'demo', target: 'en' });
    const afterFirst = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM evidence_chunk_translations',
    );
    await structuredApp
      .get(ChunkTranslatorService)
      .translatePending({ scope: 'demo', target: 'en' });
    const afterSecond = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM evidence_chunk_translations',
    );
    const translated = await pool.query<{
      section_path_translated: string[] | null;
    }>(
      `SELECT section_path_translated
       FROM evidence_chunk_translations
       WHERE chunk_id = $1 AND lang = 'en'`,
      [target.id],
    );

    expect(afterFirst.rows[0].count).toBeGreaterThan(before.rows[0].count);
    expect(afterSecond.rows[0].count).toBe(afterFirst.rows[0].count);
    expect(translated.rows[0].section_path_translated).toEqual(
      target.path.map((segment) => `[en] ${segment}`),
    );
  });

  it('[기준 11] section_path_translated=null이면 응답에서 키를 생략한다', async () => {
    const translatedControl = await getEvidence(PRIMARY_CHUNK_ID, 'en');
    const nullPath = await getEvidence(NULL_PATH_CHUNK_ID, 'en');

    expect(translatedControl.sectionPathTranslated).toEqual(PRIMARY_PATH_EN);
    expect(nullPath.excerptTranslated).toEqual(expect.any(String));
    expect('sectionPathTranslated' in nullPath).toBe(false);
  });

  it('[기준 12a] en 스트림 retrieval.completed 근거에 sectionPathTranslated가 실린다', () => {
    const detail = evidenceItemOf(
      retrievalEvidenceOf(englishEvents),
      PRIMARY_CHUNK_ID,
    );

    expect(detail.sectionPathTranslated).toEqual(PRIMARY_PATH_EN);
  });

  it('[기준 12b] en 메시지 재조회 인용에 sectionPathTranslated가 실린다', async () => {
    const messages = await getMessages(
      structuredApp,
      structuredCookie,
      englishConversationId,
    );
    const citation = citationsOfMessage(assistantMessageOf(messages)).find(
      (item) => item.evidenceId === PRIMARY_CHUNK_ID,
    );

    expect(citation).toBeDefined();
    expect(citation?.sectionPathTranslated).toEqual(PRIMARY_PATH_EN);
  });

  it('[기준 12c] en 참고안 재조회 인용에 sectionPathTranslated가 실린다', async () => {
    const guidance = await getGuidance(
      structuredApp,
      structuredCookie,
      englishGuidance.id,
    );

    expect(firstGuidanceCitation(guidance).sectionPathTranslated).toEqual(
      PRIMARY_PATH_EN,
    );
  });

  it('[기준 14a] responseLang=en 구조화 참고안은 composer_version=guidance-v2-en으로 기록된다', async () => {
    expect(await composerVersionOf(englishGuidance.id)).toBe('guidance-v2-en');
  });

  it('[기준 14b] ko 구조화 참고안은 guidance-v2를 유지하고 영문 버전과 갈린다', async () => {
    const koreanVersion = await composerVersionOf(koreanGuidance.id);
    const englishVersion = await composerVersionOf(englishGuidance.id);

    expect(koreanVersion).toBe('guidance-v2');
    expect(englishVersion).toBe('guidance-v2-en');
    expect(koreanVersion).not.toBe(englishVersion);
  });

  it('[기준 16a] 구조화 실패 영문 폴백 제목은 인용의 titleTranslated를 쓴다', async () => {
    expect(await composerVersionOf(fallbackGuidance.id)).toBe('deterministic-v1');
    const consideration = fallbackGuidance.considerations[0];

    expect(consideration.title).toContain(PRIMARY_TITLE_EN);
    expect(consideration.title).not.toContain(PRIMARY_TITLE_KO);
  });

  it('[기준 16b] 구조화 실패 영문 폴백 rationale은 인용의 quoteTranslated를 쓴다', async () => {
    expect(await composerVersionOf(fallbackGuidance.id)).toBe('deterministic-v1');
    const consideration = fallbackGuidance.considerations[0];

    expect(consideration.rationale).toBe(PRIMARY_TRANSLATION);
    expect(consideration.rationale).not.toBe(PRIMARY_CONTENT);
  });

  it('[기준 18] 언어 쿼리 없는 참고안 GET은 연결 메시지의 response_lang=en으로 경고를 렌더한다', async () => {
    const stored = await pool.query<{ response_lang: string }>(
      `SELECT m.response_lang
       FROM clinical_guidances cg
       JOIN messages m ON m.id = cg.message_id
       WHERE cg.id = $1`,
      [englishGuidance.id],
    );
    expect(stored.rows).toEqual([{ response_lang: 'en' }]);

    const guidance = await getGuidance(
      structuredApp,
      structuredCookie,
      englishGuidance.id,
    );
    const description = guidance.safetyAlerts[0]?.description;
    expectEnglish(description);
    expect(description).toContain(EN_ALLERGEN);
  });

  it('[기준 19] 영문 참고안 안전 경고에는 영문 알파벳이 있고 한글 음절이 없다', async () => {
    const guidance = await getGuidance(
      structuredApp,
      structuredCookie,
      englishGuidance.id,
    );
    const description = guidance.safetyAlerts[0]?.description;

    expectEnglish(description);
    expect(description).toContain(EN_ALLERGEN);
  });

  it('[기준 20a] 영문 참고안 재조회 인용에 quoteTranslated가 선언된 값으로 실린다', async () => {
    const guidance = await getGuidance(
      structuredApp,
      structuredCookie,
      englishGuidance.id,
    );
    const citation = firstGuidanceCitation(guidance);

    expect(citation.quoteTranslated).toBe(PRIMARY_TRANSLATION);
    expect(citation.sectionPathTranslated).toEqual(PRIMARY_PATH_EN);
    expectEnglish(guidance.safetyAlerts[0]?.description);
  });

  it('[기준 20b] 영문 참고안 재조회 인용에 titleTranslated가 선언된 값으로 실린다', async () => {
    const guidance = await getGuidance(
      structuredApp,
      structuredCookie,
      englishGuidance.id,
    );
    const citation = firstGuidanceCitation(guidance);

    expect(citation.titleTranslated).toBe(PRIMARY_TITLE_EN);
    expect(citation.sectionPathTranslated).toEqual(PRIMARY_PATH_EN);
    expectEnglish(guidance.safetyAlerts[0]?.description);
  });

  it('[기준 21] ko 참고안 인용은 번역 행이 있어도 번역 키를 하나도 싣지 않는다', async () => {
    const guidance = await getGuidance(
      structuredApp,
      structuredCookie,
      koreanGuidance.id,
    );
    const citation = firstGuidanceCitation(guidance);

    expectKeysAbsent(citation, [
      'quoteTranslated',
      'titleTranslated',
      'sectionPathTranslated',
    ]);
  });

  it('[기준 23] 영문 질의로 만든 메시지 각각이 responseLang=en을 말한다', async () => {
    const messages = await getMessages(
      structuredApp,
      structuredCookie,
      englishConversationId,
    );

    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect('responseLang' in message).toBe(true);
      expect(message.responseLang).toBe('en');
    }
    expect(assistantMessageOf(messages).responseLang).toBe('en');
  });

  it('[기준 24] responseLang을 보내지 않고 만든 메시지는 기본값 ko로 읽힌다', async () => {
    const messages = await getMessages(
      structuredApp,
      structuredCookie,
      koreanConversationId,
    );

    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect('responseLang' in message).toBe(true);
      expect(message.responseLang).toBe('ko');
    }
    expect(assistantMessageOf(messages).responseLang).toBe('ko');
  });
});
