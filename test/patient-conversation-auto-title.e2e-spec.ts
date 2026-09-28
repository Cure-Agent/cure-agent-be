// docs/specs/56 수용 기준 1~22 동결 테스트 — 구현 중 수정 금지
// 기준 23은 test/contract/openapi-sync.e2e-spec.ts에 있다. 기준 24~27은 FE(cure-agent-fe) 몫이다.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request, { Response as SupertestResponse } from 'supertest';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { EMBEDDING_PROVIDER } from '../src/infrastructure/embedding/embedding-provider.port';
import { FakeEmbeddingProvider } from '../src/infrastructure/embedding/fake-embedding.provider';
import {
  GUIDANCE_STRUCTURER, GuidanceStructurer, GuidanceStructureRequest, GuidanceStructureResult,
} from '../src/infrastructure/llm/guidance/guidance-structurer.port';
import {
  LLM_PROVIDERS, LlmProvider, LlmProviderError, LlmStreamRequest, LlmAnswerChunk,
} from '../src/infrastructure/llm/llm-provider.port';
import {
  TRANSLATOR, Translator, SupportedLang,
} from '../src/infrastructure/llm/translation/translator.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import {
  RERANKER, Reranker, RerankCandidate, RerankResult,
} from '../src/infrastructure/retrieval/reranker.port';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { compositeGuidanceSample } from './fixtures/composite-guidance-samples';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { socialSignUp, TestSession } from './fixtures/social-auth';
import { parseSseEvents } from './fixtures/sse';

const CSRF = { 'X-CSRF-Protection': '1' };
const SEPARATOR = ' \u00B7 ';
const QUESTION = '합성 기록의 검토 항목은?';
const SECOND_QUESTION = '합성 추가 기록의 확인 순서는?';
const LONG_QUESTION = '🧪 합성  기록\n검토\t' + '가'.repeat(45) + ' 끝  ';
const BACKFILL_PATH = join(__dirname, '..', 'drizzle', 'migrations', '0030_patient_conversation_title_backfill.sql');

// 구현 유틸을 빌리지 않는 명세의 독립 오라클.
function questionPart(question: string): string {
  const points = Array.from(question.replace(/\s+/g, ' ').trim());
  return points.length > 40 ? points.slice(0, 40).join('') + '…' : points.join('');
}

function expectedTitle(caseLabel: string, question: string): string {
  return caseLabel + SEPARATOR + questionPart(question);
}

function assertLongQuestion(question: string): void {
  expect([...question].length).toBeGreaterThan(40);
  expect(question.slice(0, 40)).not.toBe([...question].slice(0, 40).join(''));
  const cleaned = question.replace(/\s+/g, ' ').trim();
  expect([...cleaned].length).toBeGreaterThan(40);
  expect(cleaned.slice(0, 40)).not.toBe([...cleaned].slice(0, 40).join(''));
  expect([...questionPart(question)]).toHaveLength(41);
}

function newLabel(): string {
  return 'CASE-' + ulid().slice(-6);
}

function koTemplate(caseLabel: string): string {
  return caseLabel + ' 임상 참고 (8/4 14:30)';
}

interface Patient {
  id: string;
  caseLabel: string;
  version: number;
}

interface Conversation {
  id: string;
  title: string;
}

interface TitleRow {
  title: string;
  title_source: 'DEFAULT' | 'AUTO' | 'USER';
}

function dataOf<T>(response: SupertestResponse): T {
  expect(response.body).toMatchObject({ success: true });
  return response.body.data as T;
}

function requireString(value: unknown): string {
  expect(value).toEqual(expect.any(String));
  if (typeof value !== 'string' || !value) throw new Error('비어 있지 않은 문자열이 필요합니다.');
  return value;
}

class ControlledLlm implements LlmProvider {
  readonly name = 'spec56-fake-llm';
  mode: 'answer' | 'fail' = 'answer';

  async *streamAnswer(_input: LlmStreamRequest): AsyncIterable<LlmAnswerChunk> {
    if (this.mode === 'fail') {
      throw new LlmProviderError('합성 생성기 장애', { retryable: false });
    }
    yield { kind: 'verdict', insufficientEvidence: false, missingAspects: [] };
    yield { kind: 'delta', text: '합성 기록의 검토 항목을 정리한 가상 답변 [1].' };
  }
}

class SyntheticStructurer implements GuidanceStructurer {
  readonly model = 'spec56-fake-structurer';
  async structure(input: GuidanceStructureRequest): Promise<GuidanceStructureResult> {
    return {
      considerations: input.evidence.map((item) => ({
        title: '합성 적용 검토',
        rationale: '합성 진단 기록과 근거의 조건을 대조하는 가상 항목입니다.',
        applicability: 'CAUTION', markers: [item.marker], patientFactors: ['진단명'],
      })),
    };
  }
}

class SyntheticTranslator implements Translator {
  readonly model = 'spec56-fake-translator';
  translate(text: string, target: SupportedLang): Promise<string> {
    return Promise.resolve('[' + target + '] ' + text);
  }
}

class SyntheticReranker implements Reranker {
  readonly model = 'spec56-fake-reranker';
  rerank(_question: string, candidates: RerankCandidate[]): Promise<RerankResult> {
    return Promise.resolve({ order: candidates.map((item) => item.chunkId), top1Relevance: 10 });
  }
}

describe('docs/specs/56: 환자 대화의 자동 제목 BE 수용 기준', () => {
  jest.setTimeout(180_000);
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let owner: TestSession;
  const llm = new ControlledLlm();
  const previousEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    const settings = {
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
      DATA_PURGE_ENABLED: 'false', DATA_PURGE_CRON: '0 0 1 1 *',
      DATA_PURGE_RETENTION_DAYS: '30', DATA_PURGE_LOCK_TTL_MS: '60000',
      DATA_PURGE_BATCH_SIZE: '200',
    };
    for (const key of [...Object.keys(settings), 'DATABASE_URL', 'REDIS_URL']) {
      previousEnv.set(key, process.env[key]);
    }
    Object.assign(process.env, settings);
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.REDIS_URL = redis.getConnectionUrl();
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry).useClass(FakeOAuthProviderRegistry)
      .overrideProvider(EMBEDDING_PROVIDER).useValue(new FakeEmbeddingProvider())
      .overrideProvider(LLM_PROVIDERS).useValue([llm])
      .overrideProvider(RERANKER).useValue(new SyntheticReranker())
      .overrideProvider(TRANSLATOR).useValue(new SyntheticTranslator())
      .overrideProvider(GUIDANCE_STRUCTURER).useValue(new SyntheticStructurer())
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);
    await app.get(GuidelineIngestService).ingest(compositeGuidanceSample);
    owner = await socialSignUp(app, {
      email: 'spec56-owner@clinic.kr', providerId: 'spec56-owner',
      clinicName: '합성 환자 제목 클리닉', licenseNumber: 'spec56-owner-license',
    });
  });

  beforeEach(() => { llm.mode = 'answer'; });

  afterAll(async () => {
    try {
      try { await app?.close(); } finally {
        try { await pool?.end(); } finally {
          await Promise.all([postgres?.stop(), redis?.stop()]);
        }
      }
    } finally {
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  const post = (path: string) =>
    request(app.getHttpServer()).post(path).set(CSRF).set('Cookie', owner.cookie);
  const get = (path: string) =>
    request(app.getHttpServer()).get(path).set('Cookie', owner.cookie);
  const patch = (path: string) =>
    request(app.getHttpServer()).patch(path).set(CSRF).set('Cookie', owner.cookie);

  async function createPatient(): Promise<Patient> {
    const caseLabel = newLabel();
    const response = await post('/api/v1/patients').send({
      caseLabel,
      diagnoses: ['합성진단-' + ulid()],
      medications: ['합성약물-' + ulid()],
      allergies: ['합성알레르기-' + ulid()],
    }).expect(201);
    const patient = dataOf<Patient>(response);
    requireString(patient.id);
    expect(patient.caseLabel).toBe(caseLabel);
    expect(patient.version).toEqual(expect.any(Number));
    return patient;
  }

  async function createConversation(patientId?: string, title?: string): Promise<Conversation> {
    const response = await post('/api/v1/conversations').send({
      type: patientId === undefined ? 'GUIDELINE_QA' : 'PATIENT_GUIDANCE',
      ...(patientId === undefined ? {} : { patientId }),
      ...(title === undefined ? {} : { title }),
    }).expect(201);
    const conversation = dataOf<Conversation>(response);
    requireString(conversation.id);
    requireString(conversation.title);
    return conversation;
  }

  async function titleOf(id: string): Promise<string> {
    return requireString(dataOf<Conversation>(await get('/api/v1/conversations/' + id).expect(200)).title);
  }

  async function titleRow(id: string): Promise<TitleRow> {
    const result = await pool.query<TitleRow>(
      'SELECT title, title_source FROM conversations WHERE id = $1', [id],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  }

  async function expectRow(id: string, row: TitleRow): Promise<void> {
    expect(await titleRow(id)).toEqual(row);
  }

  async function rename(id: string, title: string): Promise<void> {
    const response = await patch('/api/v1/conversations/' + id).send({ title }).expect(200);
    expect(dataOf<Conversation>(response).title).toBe(title);
    await expectRow(id, { title, title_source: 'USER' });
  }

  async function ask(id: string, content: string, terminal: 'answer.completed' | 'error') {
    const response = await post('/api/v1/conversations/' + id + '/messages/stream')
      .send({ content, clientRequestId: randomUUID() }).expect(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = parseSseEvents(response.text);
    expect(events.filter((event) =>
      ['answer.completed', 'answer.abstained', 'error'].includes(event.eventType),
    ).map((event) => event.eventType)).toEqual([terminal]);
    expect(events[0]).toMatchObject({ eventType: 'message.accepted' });
    return events;
  }

  const askCompleted = (id: string, question: string) => ask(id, question, 'answer.completed');

  async function runtimeControl(patient: Patient, question: string): Promise<void> {
    const control = await createConversation(patient.id);
    await askCompleted(control.id, question);
    expect(await titleOf(control.id)).toBe(expectedTitle(patient.caseLabel, question));
  }

  // PATCH가 질문보다 먼저다. 런타임 구현 뒤에도 백필 직전 USER 상태를 유지한다.
  async function seedRenamed(patient: Patient, title: string, questions: string[]): Promise<string> {
    const conversation = await createConversation(patient.id);
    await rename(conversation.id, title);
    for (const question of questions) await askCompleted(conversation.id, question);
    return conversation.id;
  }

  async function expectNoMessages(id: string): Promise<void> {
    expect((await pool.query('SELECT id FROM messages WHERE conversation_id = $1', [id])).rows)
      .toHaveLength(0);
  }

  async function runBackfill(): Promise<void> {
    const statements = readFileSync(BACKFILL_PATH, 'utf8')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) await pool.query(statement);
  }

  async function changeLabel(patient: Patient): Promise<string> {
    let caseLabel = newLabel();
    while (caseLabel === patient.caseLabel) caseLabel = newLabel();
    expect(caseLabel).not.toContain(patient.caseLabel);
    expect(patient.caseLabel).not.toContain(caseLabel);
    const current = dataOf<Patient>(await get('/api/v1/patients/' + patient.id).expect(200));
    expect(current.version).toEqual(expect.any(Number));
    const response = await patch('/api/v1/patients/' + patient.id)
      .send({ version: current.version, caseLabel }).expect(200);
    expect(dataOf<Patient>(response).caseLabel).toBe(caseLabel);
    return caseLabel;
  }

  it('기준 1: 제목 없는 환자 대화의 생성 응답 제목은 케이스 라벨이다', async () => {
    const patient = await createPatient();
    expect((await createConversation(patient.id)).title).toBe(patient.caseLabel);
  });

  it('기준 2: 제목 없는 환자 대화는 라벨과 DEFAULT 출처를 저장한다', async () => {
    const patient = await createPatient();
    const conversation = await createConversation(patient.id);
    await expectRow(conversation.id, { title: patient.caseLabel, title_source: 'DEFAULT' });
  });

  it('기준 3-title: 옛 FE가 생성 요청에 실은 제목을 응답에 보존한다', async () => {
    const patient = await createPatient();
    const title = patient.caseLabel + ' 임상 참고 (9/28 14:30)';
    const subject = await createConversation(patient.id, title);
    expect(subject.title).toBe(title);
    const control = await createConversation(patient.id);
    expect(control.title).toBe(patient.caseLabel);
  });

  it('기준 3-source: 옛 FE가 생성 요청에 실은 제목은 USER 출처다', async () => {
    const patient = await createPatient();
    const title = patient.caseLabel + ' 임상 참고 (9/28 14:30)';
    const subject = await createConversation(patient.id, title);
    await expectRow(subject.id, { title, title_source: 'USER' });
    const control = await createConversation(patient.id);
    expect(control.title).toBe(patient.caseLabel);
  });

  it('기준 4: 일반 대화의 기본 제목과 DEFAULT 출처는 그대로다', async () => {
    const patient = await createPatient();
    const subject = await createConversation();
    expect(subject.title).toBe('새 대화');
    await expectRow(subject.id, { title: '새 대화', title_source: 'DEFAULT' });
    expect((await createConversation(patient.id)).title).toBe(patient.caseLabel);
  });

  it('기준 5: 짧은 첫 질문 완료 뒤 상세 제목은 라벨과 질문이다', async () => {
    const patient = await createPatient();
    expect([...QUESTION].length).toBeLessThanOrEqual(40);
    const conversation = await createConversation(patient.id);
    await askCompleted(conversation.id, QUESTION);
    expect(await titleOf(conversation.id)).toBe(expectedTitle(patient.caseLabel, QUESTION));
  });

  it('기준 6: 첫 질문 완료 뒤 라벨 접두 제목과 AUTO 출처를 저장한다', async () => {
    const patient = await createPatient();
    const conversation = await createConversation(patient.id);
    await askCompleted(conversation.id, QUESTION);
    await expectRow(conversation.id, {
      title: expectedTitle(patient.caseLabel, QUESTION), title_source: 'AUTO',
    });
  });

  it('기준 7: 긴 질문은 BMP 밖 문자를 포함한 40 코드포인트로 자르고 라벨을 보존한다', async () => {
    const patient = await createPatient();
    assertLongQuestion(LONG_QUESTION);
    const conversation = await createConversation(patient.id);
    await askCompleted(conversation.id, LONG_QUESTION);
    const title = await titleOf(conversation.id);
    expect(title).toBe(expectedTitle(patient.caseLabel, LONG_QUESTION));
    expect(title.startsWith(patient.caseLabel + SEPARATOR)).toBe(true);
  });

  it('기준 8: 첫 질문의 개행과 탭 및 연속 공백을 한 칸으로 접는다', async () => {
    const patient = await createPatient();
    const question = '  합성\n\n검토\t항목   은? ';
    const cleaned = '합성 검토 항목 은?';
    expect(question).not.toBe(cleaned);
    expect([...cleaned].length).toBeLessThanOrEqual(40);
    const conversation = await createConversation(patient.id);
    await askCompleted(conversation.id, question);
    const title = await titleOf(conversation.id);
    expect(title).toBe(expectedTitle(patient.caseLabel, question));
    expect(title).toBe(patient.caseLabel + ' \u00B7 합성 검토 항목 은?');
  });

  it('기준 9: 첫 질문이 만든 AUTO 제목을 두 번째 질문이 바꾸지 않는다', async () => {
    const patient = await createPatient();
    expect([...QUESTION].length).toBeLessThanOrEqual(40);
    expect([...SECOND_QUESTION].length).toBeLessThanOrEqual(40);
    const firstTitle = expectedTitle(patient.caseLabel, QUESTION);
    const secondTitle = expectedTitle(patient.caseLabel, SECOND_QUESTION);
    expect(firstTitle).not.toBe(secondTitle);
    const conversation = await createConversation(patient.id);
    await askCompleted(conversation.id, QUESTION);
    await expectRow(conversation.id, { title: firstTitle, title_source: 'AUTO' });
    await askCompleted(conversation.id, SECOND_QUESTION);
    const title = await titleOf(conversation.id);
    expect(title).toBe(firstTitle);
    expect(title).not.toBe(secondTitle);
    await expectRow(conversation.id, { title: firstTitle, title_source: 'AUTO' });
  });

  it('기준 10: LLM 오류로 답변이 실패해도 수락한 첫 질문의 제목은 선다', async () => {
    const patient = await createPatient();
    const conversation = await createConversation(patient.id);
    llm.mode = 'fail';
    try {
      const events = await ask(conversation.id, QUESTION, 'error');
      expect(events.find((event) => event.eventType === 'error')).toMatchObject({
        code: 'LLM_UNAVAILABLE', retryable: true,
      });
      expect(events.find((event) => event.eventType === 'answer.completed')).toBeUndefined();
      expect((await pool.query(
        "SELECT status FROM messages WHERE conversation_id = $1 AND role = 'ASSISTANT'",
        [conversation.id],
      )).rows).toEqual([{ status: 'FAILED' }]);
      expect(await titleOf(conversation.id)).toBe(expectedTitle(patient.caseLabel, QUESTION));
      await expectRow(conversation.id, {
        title: expectedTitle(patient.caseLabel, QUESTION), title_source: 'AUTO',
      });
    } finally {
      llm.mode = 'answer';
    }
  });

  it('기준 11: 완료한 환자 대화의 목록 제목도 라벨 접두 제목이다', async () => {
    const patient = await createPatient();
    const conversation = await createConversation(patient.id);
    await askCompleted(conversation.id, QUESTION);
    let cursor: string | undefined;
    let found: Conversation | undefined;
    const visited = new Set<string>();
    do {
      const response = await get('/api/v1/conversations')
        .query(cursor ? { size: 50, cursor } : { size: 50 }).expect(200);
      const rows = dataOf<Conversation[]>(response);
      expect(Array.isArray(rows)).toBe(true);
      found = rows.find((row) => row.id === conversation.id);
      if (found) break;
      const page = response.body.page as { hasNext: boolean; nextCursor: string | null };
      if (!page.hasNext) break;
      cursor = requireString(page.nextCursor);
      expect(visited.has(cursor)).toBe(false);
      visited.add(cursor);
    } while (cursor);
    expect(found).toBeDefined();
    expect(found?.title).toBe(expectedTitle(patient.caseLabel, QUESTION));
  });

  it('기준 12: 케이스 라벨만으로 검색하면 완성된 제목의 대화가 나온다', async () => {
    const patient = await createPatient();
    const conversation = await createConversation(patient.id);
    await askCompleted(conversation.id, QUESTION);
    const response = await get('/api/v1/conversations')
      .query({ query: patient.caseLabel, size: 50 }).expect(200);
    const rows = dataOf<Conversation[]>(response);
    expect(Array.isArray(rows)).toBe(true);
    const found = rows.find((row) => row.id === conversation.id);
    expect(found).toBeDefined();
    expect(found?.title).toBe(expectedTitle(patient.caseLabel, QUESTION));
  });

  it('기준 13: 첫 질문 전에 PATCH한 USER 이름을 질문이 덮지 않는다', async () => {
    const patient = await createPatient();
    const title = '합성 사용자 지정 환자 대화 이름';
    expect(title).not.toBe(patient.caseLabel);
    expect(title).not.toBe(QUESTION);
    const subject = await createConversation(patient.id);
    await rename(subject.id, title);
    await askCompleted(subject.id, QUESTION);
    expect(await titleOf(subject.id)).toBe(title);
    await expectRow(subject.id, { title, title_source: 'USER' });
    await runtimeControl(patient, QUESTION);
  });

  it('기준 14: 일반 채팅 자동 제목에는 환자 라벨 접두가 붙지 않는다', async () => {
    const patient = await createPatient();
    const subject = await createConversation();
    await askCompleted(subject.id, QUESTION);
    const title = await titleOf(subject.id);
    expect(title).toBe(questionPart(QUESTION));
    expect(title).not.toContain(SEPARATOR);
    await runtimeControl(patient, QUESTION);
  });

  it('기준 15-title: 한국어 틀 백필은 긴 첫 질문을 40 코드포인트로 잘라 라벨 뒤에 붙인다', async () => {
    const patient = await createPatient();
    assertLongQuestion(LONG_QUESTION);
    const template = koTemplate(patient.caseLabel);
    const subject = await seedRenamed(patient, template, [LONG_QUESTION]);
    await expectRow(subject, { title: template, title_source: 'USER' });
    await runBackfill();
    const title = await titleOf(subject);
    expect(title).toBe(expectedTitle(patient.caseLabel, LONG_QUESTION));
    expect(title.startsWith(patient.caseLabel + SEPARATOR)).toBe(true);
  });

  it('기준 15-source: 한국어 틀과 긴 첫 질문의 백필은 출처를 AUTO로 바꾼다', async () => {
    const patient = await createPatient();
    assertLongQuestion(LONG_QUESTION);
    const template = koTemplate(patient.caseLabel);
    const subject = await seedRenamed(patient, template, [LONG_QUESTION]);
    await expectRow(subject, { title: template, title_source: 'USER' });
    await runBackfill();
    expect((await titleRow(subject)).title_source).toBe('AUTO');
  });

  it('기준 16: 영어 FE 틀도 라벨 접두 제목과 AUTO 출처로 백필한다', async () => {
    const patient = await createPatient();
    assertLongQuestion(LONG_QUESTION);
    const template = patient.caseLabel + ' Clinical guidance (8/4 14:30)';
    const subject = await seedRenamed(patient, template, [LONG_QUESTION]);
    await expectRow(subject, { title: template, title_source: 'USER' });
    await runBackfill();
    await expectRow(subject, {
      title: expectedTitle(patient.caseLabel, LONG_QUESTION), title_source: 'AUTO',
    });
  });

  it('기준 17: 두 질문의 백필 원천은 id 오름차순 첫 USER 메시지다', async () => {
    const patient = await createPatient();
    const q1 = '  합성 첫  질문\n검토 항목은?  ';
    const q2 = SECOND_QUESTION;
    expect(expectedTitle(patient.caseLabel, q1)).not.toBe(expectedTitle(patient.caseLabel, q2));
    const template = koTemplate(patient.caseLabel);
    const subject = await seedRenamed(patient, template, [q1, q2]);
    const users = await pool.query<{ content: string }>(
      "SELECT content FROM messages WHERE conversation_id = $1 AND role = 'USER' ORDER BY id ASC",
      [subject],
    );
    expect(users.rows).toEqual([{ content: q1 }, { content: q2 }]);
    await expectRow(subject, { title: template, title_source: 'USER' });
    await runBackfill();
    const title = await titleOf(subject);
    expect(title).toBe(expectedTitle(patient.caseLabel, q1));
    expect(title).not.toBe(expectedTitle(patient.caseLabel, q2));
    expect((await titleRow(subject)).title_source).toBe('AUTO');
  });

  it('기준 18-title: 메시지 없는 FE 틀은 현재 케이스 라벨만으로 백필한다', async () => {
    const patient = await createPatient();
    const template = koTemplate(patient.caseLabel);
    const subject = await seedRenamed(patient, template, []);
    await expectNoMessages(subject);
    await expectRow(subject, { title: template, title_source: 'USER' });
    await runBackfill();
    expect(await titleOf(subject)).toBe(patient.caseLabel);
  });

  it('기준 18-source: 메시지 없는 FE 틀의 백필은 출처를 DEFAULT로 바꾼다', async () => {
    const patient = await createPatient();
    const template = koTemplate(patient.caseLabel);
    const subject = await seedRenamed(patient, template, []);
    await expectNoMessages(subject);
    await expectRow(subject, { title: template, title_source: 'USER' });
    await runBackfill();
    expect((await titleRow(subject)).title_source).toBe('DEFAULT');
  });

  it('기준 19-auto: 질문 있는 백필은 옛 제목의 라벨 대신 변경된 현재 라벨을 쓴다', async () => {
    const patient = await createPatient();
    const template = koTemplate(patient.caseLabel);
    const subject = await seedRenamed(patient, template, [QUESTION]);
    const currentLabel = await changeLabel(patient);
    await expectRow(subject, { title: template, title_source: 'USER' });
    await runBackfill();
    await expectRow(subject, {
      title: expectedTitle(currentLabel, QUESTION), title_source: 'AUTO',
    });
    expect((await titleOf(subject)).startsWith(patient.caseLabel)).toBe(false);
  });

  it('기준 19-default: 질문 없는 백필도 변경된 현재 라벨과 DEFAULT 출처를 쓴다', async () => {
    const patient = await createPatient();
    const template = koTemplate(patient.caseLabel);
    const subject = await seedRenamed(patient, template, []);
    await expectNoMessages(subject);
    const currentLabel = await changeLabel(patient);
    await expectRow(subject, { title: template, title_source: 'USER' });
    await runBackfill();
    await expectRow(subject, { title: currentLabel, title_source: 'DEFAULT' });
    expect((await titleOf(subject)).startsWith(patient.caseLabel)).toBe(false);
  });

  it('기준 20: FE 틀과 다른 USER 이름과 틀 뒤에 글자를 붙인 이름을 백필이 보존한다', async () => {
    const patient = await createPatient();
    const template = koTemplate(patient.caseLabel);
    const control = await seedRenamed(patient, template, [LONG_QUESTION]);
    const names = [patient.caseLabel + ' 재검토', template + ' 재검토'];
    const subjects: Array<{ id: string; title: string }> = [];
    for (const title of names) {
      subjects.push({ id: await seedRenamed(patient, title, [QUESTION]), title });
    }
    for (const subject of subjects) {
      await expectRow(subject.id, { title: subject.title, title_source: 'USER' });
    }
    await expectRow(control, { title: template, title_source: 'USER' });
    await runBackfill();
    // 같은 SQL 실행이 실제 대상을 바꿔야 제외 경계 단언이 유효하다.
    await expectRow(control, {
      title: expectedTitle(patient.caseLabel, LONG_QUESTION), title_source: 'AUTO',
    });
    for (const subject of subjects) {
      await expectRow(subject.id, { title: subject.title, title_source: 'USER' });
    }
  });

  it('기준 21: FE 틀과 질문이 있는 일반 대화는 백필에서 제외한다', async () => {
    const patient = await createPatient();
    const template = koTemplate(patient.caseLabel);
    const control = await seedRenamed(patient, template, [QUESTION]);
    const subject = await createConversation();
    const subjectTemplate = koTemplate(newLabel());
    await rename(subject.id, subjectTemplate);
    await askCompleted(subject.id, QUESTION);
    await expectRow(subject.id, { title: subjectTemplate, title_source: 'USER' });
    await expectRow(control, { title: template, title_source: 'USER' });
    await runBackfill();
    await expectRow(control, {
      title: expectedTitle(patient.caseLabel, QUESTION), title_source: 'AUTO',
    });
    await expectRow(subject.id, { title: subjectTemplate, title_source: 'USER' });
  });

  it('기준 22-auto: FE 틀과 질문이 있어도 이미 AUTO인 환자 대화는 백필이 보존한다', async () => {
    const patient = await createPatient();
    const template = koTemplate(patient.caseLabel);
    const control = await seedRenamed(patient, template, [QUESTION]);
    const subject = await createConversation(patient.id);
    await askCompleted(subject.id, QUESTION);
    // AUTO + FE 틀을 만드는 공개 경로가 없으므로 출처 경계 fixture에만 SQL을 쓴다.
    expect((await pool.query(
      "UPDATE conversations SET title = $1, title_source = 'AUTO' WHERE id = $2",
      [template, subject.id],
    )).rowCount).toBe(1);
    await expectRow(subject.id, { title: template, title_source: 'AUTO' });
    await expectRow(control, { title: template, title_source: 'USER' });
    await runBackfill();
    await expectRow(control, {
      title: expectedTitle(patient.caseLabel, QUESTION), title_source: 'AUTO',
    });
    await expectRow(subject.id, { title: template, title_source: 'AUTO' });
  });

  it('기준 22-default: FE 틀이고 질문이 없어도 이미 DEFAULT인 환자 대화는 백필이 보존한다', async () => {
    const patient = await createPatient();
    const template = koTemplate(patient.caseLabel);
    const control = await seedRenamed(patient, template, []);
    const subject = await createConversation(patient.id);
    await expectNoMessages(control);
    await expectNoMessages(subject.id);
    expect((await pool.query(
      "UPDATE conversations SET title = $1, title_source = 'DEFAULT' WHERE id = $2",
      [template, subject.id],
    )).rowCount).toBe(1);
    await expectRow(subject.id, { title: template, title_source: 'DEFAULT' });
    await expectRow(control, { title: template, title_source: 'USER' });
    await runBackfill();
    await expectRow(control, { title: patient.caseLabel, title_source: 'DEFAULT' });
    await expectRow(subject.id, { title: template, title_source: 'DEFAULT' });
  });
});
