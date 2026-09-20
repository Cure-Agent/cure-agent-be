// docs/specs/53 수용 기준 1~21·23·24 동결 테스트 — 구현 중 수정 금지
// 기준 22는 test/contract/openapi-sync.e2e-spec.ts에 있다.
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request from 'supertest';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { DataPurgeService } from '../src/domain/data-purge/service/data-purge.service';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { AesGcmUtil } from '../src/global/security/crypto/aes-gcm.util';
import {
  EMBEDDING_PROVIDER,
  EmbeddingProvider,
} from '../src/infrastructure/embedding/embedding-provider.port';
import { FakeEmbeddingProvider } from '../src/infrastructure/embedding/fake-embedding.provider';
import {
  LLM_PROVIDERS,
  LlmProvider,
  LlmStreamRequest,
  LlmAnswerChunk,
} from '../src/infrastructure/llm/llm-provider.port';
import {
  TRANSLATOR,
  Translator,
  SupportedLang,
} from '../src/infrastructure/llm/translation/translator.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import {
  RERANKER,
  Reranker,
  RerankCandidate,
  RerankResult,
} from '../src/infrastructure/retrieval/reranker.port';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { yotongGuideline } from './fixtures/guideline-samples';
import { socialSignUp, TestSession } from './fixtures/social-auth';
import { parseSseEvents, SseEvent } from './fixtures/sse';

const CSRF = { 'X-CSRF-Protection': '1' };
const koreanQuestion = () => `합성 사례의 중재 선택 근거를 검토해 주세요. 검토표지 ${ulid()}`;
const englishQuestion = () => `Please review intervention evidence for synthetic case ${ulid()}.`;

class RecordingEmbedding implements EmbeddingProvider {
  private readonly delegate = new FakeEmbeddingProvider();
  readonly model = this.delegate.model;
  readonly calls: string[][] = [];
  // 외부 경계에 도달한 순간의 DB 상태 관측 / HTTP 환자 변경에만 사용한다.
  onEmbed?: (texts: string[]) => Promise<void>;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    await this.onEmbed?.(texts);
    return this.delegate.embed(texts);
  }
}

class RecordingReranker implements Reranker {
  readonly model = 'spec53-recording-reranker';
  readonly calls: { question: string; candidates: RerankCandidate[] }[] = [];
  relevance = 10;

  rerank(question: string, candidates: RerankCandidate[]): Promise<RerankResult> {
    this.calls.push({ question, candidates: candidates.map((candidate) => ({ ...candidate })) });
    return Promise.resolve({
      order: candidates.map((candidate) => candidate.chunkId),
      top1Relevance: this.relevance,
    });
  }
}

class RecordingTranslator implements Translator {
  readonly model = 'spec53-recording-translator';
  readonly calls: { text: string; target: SupportedLang }[] = [];

  translate(text: string, target: SupportedLang): Promise<string> {
    this.calls.push({ text, target });
    return Promise.resolve(`[${target}] ${text}`);
  }
}

class RecordingLlm implements LlmProvider {
  readonly name = 'spec53-recording-llm';
  readonly model = 'spec53-recording-llm-model';
  readonly calls: LlmStreamRequest[] = [];
  insufficientEvidence = false;

  async *streamAnswer(input: LlmStreamRequest): AsyncIterable<LlmAnswerChunk> {
    this.calls.push({ ...input, evidence: input.evidence.map((item) => ({ ...item })) });
    yield {
      kind: 'verdict',
      insufficientEvidence: this.insufficientEvidence,
      missingAspects: this.insufficientEvidence ? ['합성 중재의 추가 판단 근거'] : [],
    };
    if (!this.insufficientEvidence) {
      yield { kind: 'delta', text: '합성 사례의 중재 검토 근거입니다 [1].' };
    }
  }
}

interface PatientFixture {
  id: string;
  version: number;
  fields: {
    diagnoses: string[];
    medications: string[];
    allergies: string[];
    clinicalNotes: string;
  };
}

interface Turn {
  conversationId: string;
  assistantMessageId: string;
  userMessageId: string;
  question: string;
  events: SseEvent[];
}

interface SnapshotRow {
  id: string;
  patient_id: string;
  payload_encrypted: string;
}

function requireEvent(events: SseEvent[], eventType: string): SseEvent {
  const event = events.find((item) => item.eventType === eventType);
  expect(event).toBeDefined();
  if (!event) throw new Error(`${eventType} 이벤트가 없습니다.`);
  return event;
}

function requireString(value: unknown): string {
  expect(value).toEqual(expect.any(String));
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('비어 있지 않은 문자열이 필요합니다.');
  }
  return value;
}

// 기대값은 프로덕션 composeGuidanceQuestion을 호출하지 않고 공개된 합성 계약으로 만든다.
function expectedGenerationQuestion(patient: PatientFixture, question: string): string {
  const fields = patient.fields;
  return (
    `[환자 프로필] 진단: ${fields.diagnoses.join(', ') || '정보 없음'} / ` +
    `투약: ${fields.medications.join(', ') || '정보 없음'} / ` +
    `알레르기: ${fields.allergies.join(', ') || '없음'} / ` +
    `임상 메모: ${fields.clinicalNotes}\n${question}`
  );
}

describe('docs/specs/53: 환자 대화의 검색 입력과 턴 스냅샷', () => {
  jest.setTimeout(180_000);

  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let owner: TestSession;
  const embedding = new RecordingEmbedding();
  const reranker = new RecordingReranker();
  const translator = new RecordingTranslator();
  const llm = new RecordingLlm();
  const previousEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    const settings: Record<string, string> = {
      RETRIEVAL_DISTANCE_CUTOFF: '2',
      RETRIEVAL_RERANK_ENABLED: 'true',
      RETRIEVAL_RERANK_SCORE_CUTOFF: '9',
      LLM_ANSWERABILITY_GATE_ENABLED: 'true',
      OPENAI_API_KEY: '',
      DATA_PURGE_ENABLED: 'false',
      DATA_PURGE_CRON: '0 0 1 1 *',
      DATA_PURGE_RETENTION_DAYS: '30',
      DATA_PURGE_LOCK_TTL_MS: '60000',
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
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(embedding)
      .overrideProvider(RERANKER)
      .useValue(reranker)
      .overrideProvider(TRANSLATOR)
      .useValue(translator)
      .overrideProvider(LLM_PROVIDERS)
      .useValue([llm])
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);
    // 실제 지침이 아닌, 기존 스위트의 합성 근거 fixture다.
    await app.get(GuidelineIngestService).ingest(yotongGuideline);
    owner = await socialSignUp(app, {
      email: 'spec53-owner@clinic.kr',
      providerId: 'spec53-owner',
      clinicName: '합성 검색 동결 클리닉',
      licenseNumber: 'spec53-owner-license',
    });
  });

  beforeEach(() => {
    embedding.calls.length = 0;
    embedding.onEmbed = undefined;
    reranker.calls.length = 0;
    reranker.relevance = 10;
    translator.calls.length = 0;
    llm.calls.length = 0;
    llm.insufficientEvidence = false;
  });

  afterAll(async () => {
    try {
      await app?.close();
      await pool?.end();
      await postgres?.stop();
      await redis?.stop();
    } finally {
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  async function createPatient(
    diagnoses = [`합성진단-${ulid()}`],
    session = owner,
  ): Promise<PatientFixture> {
    const fields = {
      diagnoses,
      medications: [`합성약물-${ulid()}`],
      allergies: [`합성알레르기-${ulid()}`],
      clinicalNotes: `합성 임상 메모 ${ulid()}`,
    };
    const response = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set(CSRF)
      .set('Cookie', session.cookie)
      .send({ caseLabel: `Spec53-${ulid()}`, ...fields })
      .expect(201);
    expect(response.body).toMatchObject({
      success: true,
      data: { id: expect.any(String), version: expect.any(Number), ...fields },
    });
    return { id: response.body.data.id as string, version: response.body.data.version as number, fields };
  }

  async function createConversation(patient?: PatientFixture, session = owner): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', session.cookie)
      .send(patient ? { type: 'PATIENT_GUIDANCE', patientId: patient.id } : { type: 'GUIDELINE_QA' })
      .expect(201);
    expect(response.body.success).toBe(true);
    return requireString(response.body.data.id);
  }

  async function ask(
    conversationId: string,
    question: string,
    session = owner,
    terminal = 'answer.completed',
  ): Promise<Turn> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .set(CSRF)
      .set('Cookie', session.cookie)
      .send({ content: question, clientRequestId: randomUUID() })
      .expect(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = parseSseEvents(response.text.replace(/\r\n/g, '\n'));
    expect(events.filter((event) => event.eventType === 'error')).toEqual([]);
    expect(events.at(-1)?.eventType).toBe(terminal);
    const accepted = requireEvent(events, 'message.accepted');
    const assistantMessageId = requireString(accepted.assistantMessageId);
    expect(requireEvent(events, terminal).message).toMatchObject({
      id: assistantMessageId,
      status: terminal === 'answer.completed' ? 'COMPLETED' : 'ABSTAINED',
    });
    return {
      conversationId,
      assistantMessageId,
      userMessageId: requireString(accepted.userMessageId),
      question,
      events,
    };
  }

  async function completedPatientTurn(patient: PatientFixture, question = koreanQuestion(), session = owner) {
    return ask(await createConversation(patient, session), question, session);
  }

  async function run(turn: Turn) {
    const result = await pool.query<{ search_question: string; original_question: string }>(
      'SELECT search_question, original_question FROM generation_runs WHERE message_id = $1',
      [turn.assistantMessageId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  }

  async function snapshots(patientId: string): Promise<SnapshotRow[]> {
    const result = await pool.query<SnapshotRow>(
      'SELECT id, patient_id, payload_encrypted FROM patient_profile_snapshots WHERE patient_id = $1',
      [patientId],
    );
    return result.rows;
  }

  async function message(messageId: string) {
    const result = await pool.query<{
      role: string;
      status: string;
      patient_snapshot_id: string | null;
      abstain_reason: string | null;
    }>(
      'SELECT role, status, patient_snapshot_id, abstain_reason FROM messages WHERE id = $1',
      [messageId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  }

  async function pinnedSnapshot(turn: Turn, patient: PatientFixture): Promise<SnapshotRow> {
    const row = await message(turn.assistantMessageId);
    expect(row.role).toBe('ASSISTANT');
    const id = requireString(row.patient_snapshot_id);
    const result = await pool.query<SnapshotRow>(
      'SELECT id, patient_id, payload_encrypted FROM patient_profile_snapshots WHERE id = $1',
      [id],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].patient_id).toBe(patient.id);
    return result.rows[0];
  }

  async function searchAbstained(patient: PatientFixture): Promise<Turn> {
    reranker.relevance = 0;
    const turn = await ask(await createConversation(patient), koreanQuestion(), owner, 'answer.abstained');
    expect(turn.events.filter((event) => event.eventType === 'retrieval.evidence')).toHaveLength(0);
    expect(turn.events.filter((event) => event.eventType === 'answer.started')).toHaveLength(0);
    expect(reranker.calls).toHaveLength(1);
    expect(reranker.calls[0].candidates.length).toBeGreaterThan(0);
    expect(llm.calls).toHaveLength(0);
    expect(await message(turn.assistantMessageId)).toMatchObject({
      status: 'ABSTAINED', abstain_reason: 'beyond_cutoff',
    });
    return turn;
  }

  async function expectPatientPurged(patient: PatientFixture, turn: Turn) {
    // 부모 행과 JOIN하지 않는다. 부모가 지워져도 남아 있는 자식 행을 숨기지 않는다.
    const queries: [string, string][] = [
      ['SELECT id FROM conversations WHERE id = $1', turn.conversationId],
      ['SELECT id FROM messages WHERE conversation_id = $1', turn.conversationId],
      ['SELECT id FROM patients WHERE id = $1', patient.id],
      ['SELECT id FROM patient_profile_snapshots WHERE patient_id = $1', patient.id],
    ];
    for (const [sql, id] of queries) {
      expect((await pool.query(sql, [id])).rows).toHaveLength(0);
    }
  }

  it('기준 1 (RED): 환자 대화의 search_question은 질문 뒤에 진단명이 붙는다', async () => {
    const patient = await createPatient();
    const turn = await completedPatientTurn(patient);
    expect((await run(turn)).search_question).toBe(`${turn.question} ${patient.fields.diagnoses[0]}`);
  });

  it('기준 2 (RED): 실제 임베딩 입력은 search_question과 같고 진단명을 포함한다', async () => {
    const patient = await createPatient();
    const turn = await completedPatientTurn(patient);
    const inputs = embedding.calls.flat().filter((text) => text.includes(turn.question));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toBe((await run(turn)).search_question);
    expect(inputs[0]).toContain(patient.fields.diagnoses[0]);
    expect(inputs[0]).toBe(`${turn.question} ${patient.fields.diagnoses[0]}`);
  });

  it('기준 3 (RED): 복수 진단은 기록된 순서대로 전부 붙는다', async () => {
    // 사전순 정렬도 잡도록 생성 순서와 반대로 기록한다.
    const names = [`합성진단-${ulid()}`, `합성진단-${ulid()}`].sort().reverse();
    const patient = await createPatient(names);
    const turn = await completedPatientTurn(patient);
    expect((await run(turn)).search_question).toBe(`${turn.question} ${names[0]} ${names[1]}`);
  });

  it('기준 4 (RED): 질문이 진단명을 이미 담아도 한 번 더 붙인다', async () => {
    const patient = await createPatient();
    const diagnosis = patient.fields.diagnoses[0];
    const turn = await completedPatientTurn(patient, `${diagnosis} 관련 ${koreanQuestion()}`);
    expect((await run(turn)).search_question).toBe(`${turn.question} ${diagnosis}`);
  });

  it('기준 5 (가드): 진단이 없는 환자는 뒤 공백 없이 질문 그대로 검색한다', async () => {
    const turn = await completedPatientTurn(await createPatient([]));
    expect((await run(turn)).search_question).toBe(turn.question);
  });

  it('기준 6 (RED): 영문 리랭크 질문은 번역문이 아닌 사용자 원문 뒤에 같은 진단명들이 붙는다', async () => {
    const patient = await createPatient([`합성진단-${ulid()}`, `합성진단-${ulid()}`]);
    const turn = await completedPatientTurn(patient, englishQuestion());
    expect(reranker.calls).toHaveLength(1);
    expect(reranker.calls[0].candidates.length).toBeGreaterThan(0);
    expect(reranker.calls[0].question).toBe(`${turn.question} ${patient.fields.diagnoses.join(' ')}`);
    expect(reranker.calls[0].question).not.toContain('[ko]');
  });

  it('기준 7 (가드): 영문 질문 번역은 ko로 호출되고 입력에는 한국어 진단명이 없다', async () => {
    const patient = await createPatient();
    const turn = await completedPatientTurn(patient, englishQuestion());
    const calls = translator.calls.filter((call) => call.target === 'ko');
    expect(calls).toEqual([{ text: turn.question, target: 'ko' }]);
    for (const call of calls) expect(call.text).not.toContain(patient.fields.diagnoses[0]);
  });

  it('기준 8 (RED): 영문 질문 검색에는 번역문 뒤에 진단명이 붙는다', async () => {
    const patient = await createPatient();
    const turn = await completedPatientTurn(patient, englishQuestion());
    expect(translator.calls).toContainEqual({ text: turn.question, target: 'ko' });
    const expected = `[ko] ${turn.question} ${patient.fields.diagnoses[0]}`;
    expect((await run(turn)).search_question).toBe(expected);
    expect(embedding.calls.flat().filter((text) => text.includes(turn.question))).toEqual([expected]);
  });

  it('기준 9 (가드): 생성 질문은 프로필 블록과 원문 질문이며 진단명이 뒤에 덧붙지 않는다', async () => {
    const patient = await createPatient();
    const turn = await completedPatientTurn(patient);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].question).toBe(expectedGenerationQuestion(patient, turn.question));
    expect(llm.calls[0].question.endsWith(turn.question)).toBe(true);
    // 진단 밖 필드는 생성에만 들어가고 검색·리랭크에는 들어가지 않는다.
    const searchInputs = embedding.calls.flat().filter((text) => text.includes(turn.question));
    expect(searchInputs).toHaveLength(1);
    expect(reranker.calls).toHaveLength(1);
    for (const field of [
      ...patient.fields.medications, ...patient.fields.allergies, patient.fields.clinicalNotes,
    ]) {
      expect(searchInputs[0]).not.toContain(field);
      expect(reranker.calls[0].question).not.toContain(field);
    }
  });

  it('기준 10 (가드): original_question은 번역·프로필·진단을 붙이기 전 사용자 원문이다', async () => {
    const patient = await createPatient();
    const turn = await completedPatientTurn(patient, englishQuestion());
    expect((await run(turn)).original_question).toBe(turn.question);
  });

  it('기준 11 (RED): 검색에 진입하기 전에 고정한 환자 스냅샷을 완료 메시지가 가리킨다', async () => {
    const patient = await createPatient();
    const conversationId = await createConversation(patient);
    const question = koreanQuestion();
    const observations: { patient_snapshot_id: string | null; patient_id: string | null }[][] = [];
    embedding.onEmbed = async (texts) => {
      if (!texts.some((text) => text.includes(question))) return;
      const result = await pool.query<{ patient_snapshot_id: string | null; patient_id: string | null }>(
        `SELECT m.patient_snapshot_id, s.patient_id
           FROM messages m LEFT JOIN patient_profile_snapshots s ON s.id = m.patient_snapshot_id
          WHERE m.conversation_id = $1 AND m.role = 'ASSISTANT'`,
        [conversationId],
      );
      observations.push(result.rows);
    };
    const turn = await ask(conversationId, question);
    const snapshot = await pinnedSnapshot(turn, patient);
    expect(observations).toEqual([[{ patient_snapshot_id: snapshot.id, patient_id: patient.id }]]);
    expect(await message(turn.assistantMessageId)).toMatchObject({ status: 'COMPLETED' });
  });

  it('기준 12 (가드): 정상 턴의 스냅샷은 검색용·생성용 구분 없이 정확히 한 건만 늘어난다', async () => {
    const patient = await createPatient();
    const before = await snapshots(patient.id);
    await completedPatientTurn(patient);
    const after = await snapshots(patient.id);
    expect(after.length - before.length).toBe(1);
  });

  it('기준 13 (RED): 검색 중 환자가 바뀌어도 검색·생성·참고안은 메시지의 같은 스냅샷을 쓴다', async () => {
    const patient = await createPatient();
    const question = koreanQuestion();
    const changed = {
      diagnoses: [`합성진단-${ulid()}`],
      medications: [`합성약물-${ulid()}`],
      allergies: [`합성알레르기-${ulid()}`],
      clinicalNotes: `변경된 합성 메모 ${ulid()}`,
    };
    let changedCount = 0;
    embedding.onEmbed = async (texts) => {
      if (changedCount > 0 || !texts.some((text) => text.includes(question))) return;
      changedCount += 1;
      await request(app.getHttpServer())
        .patch(`/api/v1/patients/${patient.id}`)
        .set(CSRF)
        .set('Cookie', owner.cookie)
        .send({ version: patient.version, ...changed })
        .expect(200);
    };
    const turn = await completedPatientTurn(patient, question);
    expect(changedCount).toBe(1);
    const current = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patient.id}`)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(current.body.data).toMatchObject(changed);
    const snapshot = await pinnedSnapshot(turn, patient);
    expect(JSON.parse(app.get(AesGcmUtil).decrypt(snapshot.payload_encrypted))).toMatchObject({
      patientId: patient.id, ...patient.fields,
    });
    const guidances = await pool.query<{ patient_snapshot_id: string }>(
      'SELECT patient_snapshot_id FROM clinical_guidances WHERE message_id = $1',
      [turn.assistantMessageId],
    );
    expect(guidances.rows).toEqual([{ patient_snapshot_id: snapshot.id }]);
    expect((await run(turn)).search_question).toBe(`${question} ${patient.fields.diagnoses[0]}`);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].question).toBe(expectedGenerationQuestion(patient, question));
    expect(await snapshots(patient.id)).toHaveLength(1);
  });

  it('기준 14 (RED): 검색 점수 게이트에서 기권해도 환자 스냅샷을 메시지에 고정한다', async () => {
    const patient = await createPatient();
    const turn = await searchAbstained(patient);
    const snapshot = await pinnedSnapshot(turn, patient);
    expect(JSON.parse(app.get(AesGcmUtil).decrypt(snapshot.payload_encrypted))).toMatchObject({
      patientId: patient.id, diagnoses: patient.fields.diagnoses,
    });
    expect(await snapshots(patient.id)).toHaveLength(1);
  });

  it('기준 15 (가드): 검색 게이트 기권에는 generation run이 없다', async () => {
    const turn = await searchAbstained(await createPatient());
    const result = await pool.query('SELECT id FROM generation_runs WHERE message_id = $1', [turn.assistantMessageId]);
    expect(result.rows).toHaveLength(0);
  });

  it('기준 16 (가드): 검색 게이트 기권에는 참고안이 없다', async () => {
    const turn = await searchAbstained(await createPatient());
    const result = await pool.query('SELECT id FROM clinical_guidances WHERE message_id = $1', [turn.assistantMessageId]);
    expect(result.rows).toHaveLength(0);
  });

  it('기준 17 (RED): 생성 LLM의 기권 verdict에도 메시지는 환자 스냅샷을 가리킨다', async () => {
    const patient = await createPatient();
    llm.insufficientEvidence = true;
    const turn = await ask(await createConversation(patient), koreanQuestion(), owner, 'answer.abstained');
    expect(llm.calls).toHaveLength(1);
    expect(turn.events.filter((event) => event.eventType === 'retrieval.evidence').length).toBeGreaterThan(0);
    expect(await message(turn.assistantMessageId)).toMatchObject({
      status: 'ABSTAINED', abstain_reason: 'insufficient_evidence',
    });
    await run(turn);
    await pinnedSnapshot(turn, patient);
  });

  it('기준 18 (가드): 환자 대화의 USER 메시지는 스냅샷 참조가 NULL이다', async () => {
    const turn = await completedPatientTurn(await createPatient());
    expect(await message(turn.userMessageId)).toMatchObject({ role: 'USER', patient_snapshot_id: null });
  });

  it('기준 19 (가드): 일반 대화 ASSISTANT 메시지는 스냅샷 참조가 NULL이다', async () => {
    const turn = await ask(await createConversation(), koreanQuestion());
    expect(await message(turn.assistantMessageId)).toMatchObject({ role: 'ASSISTANT', patient_snapshot_id: null });
  });

  it('기준 20 (가드): 일반 대화의 search_question은 질문 그대로다', async () => {
    const turn = await ask(await createConversation(), koreanQuestion());
    expect((await run(turn)).search_question).toBe(turn.question);
  });

  it('기준 21 (가드): 메시지 목록에는 스냅샷 필드도 실제 스냅샷 id도 없다', async () => {
    const patient = await createPatient();
    const turn = await completedPatientTurn(patient);
    // 스텁에도 생성용 스냅샷은 있다. 새 pin 기능을 가드의 전제조건으로 삼지 않는다.
    const rows = await snapshots(patient.id);
    expect(rows).toHaveLength(1);
    const response = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${turn.conversationId}/messages`)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(response.body.success).toBe(true);
    const messages = response.body.data as Array<Record<string, unknown>>;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((item) => item.id).sort()).toEqual([turn.userMessageId, turn.assistantMessageId].sort());
    for (const item of messages) {
      expect(item).not.toHaveProperty('patientSnapshotId');
      expect(item).not.toHaveProperty('patientProfileSnapshotId');
      expect(item).not.toHaveProperty('patient_snapshot_id');
    }
    for (const row of rows) expect(JSON.stringify(response.body)).not.toContain(row.id);
  });

  it('기준 23 (가드): 환자 삭제 유예 뒤 대화·메시지·스냅샷·환자가 오류 없이 파기된다', async () => {
    const patient = await createPatient();
    const turn = await completedPatientTurn(patient);
    expect(await snapshots(patient.id)).toHaveLength(1);
    expect(await message(turn.assistantMessageId)).toMatchObject({ status: 'COMPLETED' });
    const deleted = await request(app.getHttpServer())
      .delete(`/api/v1/patients/${patient.id}`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(deleted.body.success).toBe(true);
    for (const [table, id] of [['conversations', turn.conversationId], ['patients', patient.id]]) {
      const reserved = await pool.query<{ deleted_at: Date | null }>(`SELECT deleted_at FROM ${table} WHERE id = $1`, [id]);
      expect(reserved.rows).toHaveLength(1);
      expect(reserved.rows[0].deleted_at).not.toBeNull();
      const aged = await pool.query(`UPDATE ${table} SET deleted_at = now() - interval '400 days' WHERE id = $1`, [id]);
      expect(aged.rowCount).toBe(1);
    }
    // #473: 후보 산출 시 대화가 남은 환자는 보류한다. 첫 틱이 대화를 지운 뒤
    // 다음 틱에서 환자가 후보가 된다. 두 호출 모두 예외 없이 끝나야 한다.
    await expect(app.get(DataPurgeService).purge()).resolves.toMatchObject({ skipped: false });
    await expect(app.get(DataPurgeService).purge()).resolves.toMatchObject({ skipped: false });
    await expectPatientPurged(patient, turn);
  });

  it('기준 24 (가드): 별도 클리닉 파기는 환자 대화와 스냅샷까지 오류 없이 지운다', async () => {
    const suffix = ulid();
    const session = await socialSignUp(app, {
      email: `spec53-purge-${suffix}@clinic.kr`,
      providerId: `spec53-purge-${suffix}`,
      clinicName: '파기 전용 합성 클리닉',
      licenseNumber: `spec53-purge-${suffix}`,
    });
    expect(session.clinicId).not.toBe(owner.clinicId);
    const patient = await createPatient(undefined, session);
    const turn = await completedPatientTurn(patient, koreanQuestion(), session);
    expect(await snapshots(patient.id)).toHaveLength(1);
    expect(await message(turn.assistantMessageId)).toMatchObject({ status: 'COMPLETED' });
    // 대화·환자는 예약하지 않는다. 클리닉 파기 내부의 대화 → 환자 순서를 탄다.
    const aged = await pool.query(
      "UPDATE clinics SET deleted_at = now() - interval '400 days' WHERE id = $1",
      [session.clinicId],
    );
    expect(aged.rowCount).toBe(1);
    await expect(app.get(DataPurgeService).purge()).resolves.toMatchObject({ skipped: false });
    await expectPatientPurged(patient, turn);
    for (const table of ['conversations', 'patients', 'patient_profile_snapshots']) {
      expect((await pool.query(`SELECT id FROM ${table} WHERE clinic_id = $1`, [session.clinicId])).rows).toHaveLength(0);
    }
    expect((await pool.query('SELECT id FROM clinics WHERE id = $1', [session.clinicId])).rows).toHaveLength(0);
    expect((await pool.query('SELECT id FROM clinics WHERE id = $1', [owner.clinicId])).rows).toHaveLength(1);
  });
});
