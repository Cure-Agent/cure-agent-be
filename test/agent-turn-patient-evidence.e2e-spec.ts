// docs/specs/51 수용 기준 88~105·118~120 동결 테스트 — 구현 중 수정 금지
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
import { PatientDetailResponseDto } from '../src/domain/patient/dto/response/patient-detail.response.dto';
import {
  EMBEDDING_PROVIDER,
  EmbeddingProvider,
  EmbeddingProviderError,
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
import { socialSignUp, socialLogin, TestSession } from './fixtures/social-auth';
import { parseSseEvents, SseEvent } from './fixtures/sse';

const CSRF = { 'X-CSRF-Protection': '1' };
const QUESTION = '만성 요통에 침 치료를 권고하나요?';
const FAILURE_MARKER = '합성임베딩실패표지';

function latch(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function blockControl() {
  return { entered: latch(), release: latch(), returned: latch() };
}

class ControlledEmbedding implements EmbeddingProvider {
  private readonly delegate = new FakeEmbeddingProvider();
  readonly model = this.delegate.model;
  readonly blocks = new Map<string, ReturnType<typeof blockControl>>();

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.some((text) => text.includes(FAILURE_MARKER))) {
      throw new EmbeddingProviderError('합성 임베딩 실패', { retryable: true });
    }
    const block = [...this.blocks].find(([marker]) =>
      texts.some((text) => text.includes(marker)),
    )?.[1];
    if (block) {
      block.entered.resolve();
      await block.release.promise;
    }
    const vectors = await this.delegate.embed(texts);
    block?.returned.resolve();
    return vectors;
  }
}

class CountingLlm implements LlmProvider {
  readonly name = 'spec51b-counting-llm';
  calls = 0;

  streamAnswer(_request: LlmStreamRequest): AsyncIterable<LlmAnswerChunk> {
    this.calls += 1;
    return this.chunks();
  }

  private async *chunks(): AsyncIterable<LlmAnswerChunk> {
    yield { kind: 'verdict', insufficientEvidence: false, missingAspects: [] };
    yield { kind: 'delta', text: '합성 근거를 인용한 답변입니다 [1].' };
  }
}

class RecordingTranslator implements Translator {
  readonly model = 'spec51b-translator';
  readonly calls: { text: string; target: SupportedLang }[] = [];

  translate(text: string, target: SupportedLang): Promise<string> {
    this.calls.push({ text, target });
    return Promise.resolve(`[${target}] ${text}`);
  }
}

class AbstainingReranker implements Reranker {
  readonly model = 'spec51b-zero-relevance';

  rerank(_question: string, candidates: RerankCandidate[]): Promise<RerankResult> {
    return Promise.resolve({
      order: candidates.map((candidate) => candidate.chunkId),
      top1Relevance: 0,
    });
  }
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 관측 시간 초과`)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readStarted(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
): Promise<SseEvent[]> {
  const decoder = new TextDecoder();
  let buffer = '';
  const events: SseEvent[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let boundary = /\r?\n\r?\n/.exec(buffer);
    while (boundary) {
      events.push(...parseSseEvents(buffer.slice(0, boundary.index).replace(/\r\n/g, '\n')));
      buffer = buffer.slice(boundary.index + boundary[0].length);
      boundary = /\r?\n\r?\n/.exec(buffer);
    }
    if (events.some((event) => event.eventType === 'retrieval.started') || done) {
      return events;
    }
  }
}

interface Turn {
  conversationId: string;
  assistantMessageId: string;
}

interface Resolution {
  outcome: 'RESOLVED' | 'NOT_FOUND' | 'AMBIGUOUS';
  patient?: PatientDetailResponseDto;
}

describe('docs/specs/51: 환자 도구·근거 도구·환자 삭제 연쇄', () => {
  jest.setTimeout(180_000);

  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let abstainApp: INestApplication;
  let owner: TestSession;
  let foreign: TestSession;
  let abstainCookie: string;
  const embedding = new ControlledEmbedding();
  const llm = new CountingLlm();
  const translator = new RecordingTranslator();
  const previousEnv = new Map<string, string | undefined>();
  const identity = { email: 'spec51b-owner@clinic.kr', providerId: 'spec51b-owner' };

  beforeAll(async () => {
    const settings: Record<string, string> = {
      DATA_PURGE_ENABLED: 'false',
      DATA_PURGE_CRON: '0 0 1 1 *',
      DATA_PURGE_RETENTION_DAYS: '30',
      DATA_PURGE_LOCK_TTL_MS: '60000',
      DATA_PURGE_BATCH_SIZE: '200',
      RETRIEVAL_RERANK_ENABLED: 'true',
      RETRIEVAL_RERANK_SCORE_CUTOFF: '9',
      RETRIEVAL_DISTANCE_CUTOFF: '2',
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

    const mainModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(embedding)
      .overrideProvider(LLM_PROVIDERS)
      .useValue([llm])
      .overrideProvider(TRANSLATOR)
      .useValue(translator)
      .compile();
    app = mainModule.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);
    await app.get(GuidelineIngestService).ingest(yotongGuideline);
    owner = await socialSignUp(app, {
      ...identity,
      clinicName: 'spec51b 소유 클리닉',
      licenseNumber: 'spec51b-owner-license',
    });
    foreign = await socialSignUp(app, {
      email: 'spec51b-foreign@clinic.kr',
      providerId: 'spec51b-foreign',
      clinicName: 'spec51b 타 클리닉',
      licenseNumber: 'spec51b-foreign-license',
    });
    const abstainModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(RERANKER)
      .useValue(new AbstainingReranker())
      .compile();
    abstainApp = abstainModule.createNestApplication();
    abstainApp.setGlobalPrefix('api/v1');
    abstainApp.use(cookieParser());
    await bootstrapApp(abstainApp);
    abstainCookie = await socialLogin(abstainApp, identity);
  });

  afterAll(async () => {
    for (const block of embedding.blocks.values()) block.release.resolve();
    try {
      await abstainApp?.close();
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
    caseLabel = `Spec51-Case-${ulid()}`,
    session = owner,
    diagnoses = [`합성진단-${ulid()}`],
  ) {
    const fields = {
      diagnoses,
      medications: [`합성약물-${ulid()}`],
      allergies: [`합성알레르기-${ulid()}`],
      clinicalNotes: `합성 메모 ${ulid()}`,
    };
    const response = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set(CSRF)
      .set('Cookie', session.cookie)
      .send({ caseLabel, ...fields })
      .expect(201);
    expect(response.body).toMatchObject({ success: true, data: { id: expect.any(String) } });
    return { id: response.body.data.id as string, caseLabel, fields };
  }

  async function accept(targetApp = app, cookie = owner.cookie): Promise<Turn> {
    const conversation = await request(targetApp.getHttpServer())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ type: 'GUIDELINE_QA' })
      .expect(201);
    expect(conversation.body).toMatchObject({
      success: true,
      data: { id: expect.any(String) },
    });
    const conversationId = conversation.body.data.id as string;
    const response = await request(targetApp.getHttpServer())
      .post(`/api/v1/internal/agent/conversations/${conversationId}/turns`)
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ content: `합성 질문 ${ulid()}: ${QUESTION}`, clientRequestId: randomUUID() })
      .expect(201);
    expect(response.body).toMatchObject({
      success: true,
      data: { assistantMessageId: expect.any(String), userMessageId: expect.any(String) },
    });
    return { conversationId, assistantMessageId: response.body.data.assistantMessageId as string };
  }

  async function resolvePatient(turn: Turn, caseLabel: string): Promise<Resolution> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/internal/agent/turns/${turn.assistantMessageId}/patient`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .send({ caseLabel })
      .expect(200);
    expect(response.body.success).toBe(true);
    return response.body.data as Resolution;
  }

  async function resolved(turn: Turn, patient: { id: string; caseLabel: string }) {
    const result = await resolvePatient(turn, patient.caseLabel);
    expect(result).toMatchObject({ outcome: 'RESOLVED', patient: { id: patient.id } });
    return result;
  }

  async function evidence(
    turn: Turn,
    query = QUESTION,
    targetApp = app,
    cookie = owner.cookie,
  ): Promise<SseEvent[]> {
    const response = await request(targetApp.getHttpServer())
      .post(`/api/v1/internal/agent/turns/${turn.assistantMessageId}/guideline-evidence`)
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ query })
      .expect(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    return parseSseEvents(response.text.replace(/\r\n/g, '\n'));
  }

  function requireEvent(events: SseEvent[], type: string): SseEvent {
    const event = events.find((item) => item.eventType === type);
    expect(event).toBeDefined();
    if (!event) throw new Error(`${type} 이벤트가 없습니다.`);
    return event;
  }

  function completed(events: SseEvent[]): void {
    requireEvent(events, 'evidence.gated');
    expect(events.at(-1)?.eventType).toBe('retrieval.completed');
  }

  async function snapshots(patientId: string): Promise<{ id: string }[]> {
    const result = await pool.query<{ id: string }>(
      'SELECT id FROM patient_profile_snapshots WHERE patient_id = $1',
      [patientId],
    );
    return result.rows;
  }

  async function snapshotId(turn: Turn): Promise<string | null> {
    const result = await pool.query<{ patient_snapshot_id: string | null }>(
      'SELECT patient_snapshot_id FROM agent_turns WHERE message_id = $1',
      [turn.assistantMessageId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0].patient_snapshot_id;
  }

  async function expectStreaming(turn: Turn): Promise<void> {
    const result = await pool.query<{ role: string; status: string; content: string }>(
      'SELECT role, status, content FROM messages WHERE id = $1',
      [turn.assistantMessageId],
    );
    expect(result.rows).toEqual([{ role: 'ASSISTANT', status: 'STREAMING', content: '' }]);
  }

  async function deletedAt(table: 'conversations' | 'patients', id: string) {
    const result = await pool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM ${table} WHERE id = $1`,
      [id],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0].deleted_at;
  }

  async function deletePatient(id: string): Promise<void> {
    const response = await request(app.getHttpServer())
      .delete(`/api/v1/patients/${id}`)
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(response.body.success).toBe(true);
  }

  it('기준 88: 대소문자를 바꾼 정확한 라벨을 유일한 환자로 해석한다', async () => {
    const patient = await createPatient();
    const turn = await accept();
    const upper = patient.caseLabel.toUpperCase();
    expect(upper).not.toBe(patient.caseLabel);
    expect(await resolvePatient(turn, upper)).toMatchObject({
      outcome: 'RESOLVED',
      patient: { id: patient.id },
    });
  });

  it('기준 89: 해석된 환자의 기록 필드를 복호화하여 반환한다', async () => {
    const patient = await createPatient();
    const result = await resolved(await accept(), patient);
    expect(result.patient).toMatchObject(patient.fields);
  });

  it('기준 90: 새 스냅샷을 만들고 수락한 턴에 연결한다', async () => {
    const patient = await createPatient();
    const turn = await accept();
    expect(await snapshots(patient.id)).toHaveLength(0);
    await resolved(turn, patient);
    const rows = await snapshots(patient.id);
    expect(rows).toHaveLength(1);
    expect(await snapshotId(turn)).toBe(rows[0].id);
  });

  it('기준 91: 라벨의 부분 일치는 환자로 해석하지 않는다', async () => {
    const prefix = `X-${ulid()}-00`;
    await createPatient(`${prefix}1`);
    const result = await resolvePatient(await accept(), prefix);
    expect(result.outcome).toBe('NOT_FOUND');
    expect(result).not.toHaveProperty('patient');
  });

  it('기준 92: 타 클리닉에만 존재하는 라벨은 찾지 못한다', async () => {
    const patient = await createPatient(`Foreign-${ulid()}`, foreign);
    const result = await resolvePatient(await accept(), patient.caseLabel);
    expect(result.outcome).toBe('NOT_FOUND');
  });

  it('기준 93: 소유 클리닉의 같은 라벨 두 명은 모호함으로 반환한다', async () => {
    const label = `Duplicate-${ulid()}`;
    await createPatient(label);
    await createPatient(label);
    expect((await resolvePatient(await accept(), label)).outcome).toBe('AMBIGUOUS');
  });

  it('기준 94: 모호한 두 환자의 스냅샷과 턴 연결을 만들지 않는다', async () => {
    const label = `Ambiguous-${ulid()}`;
    const first = await createPatient(label);
    const second = await createPatient(label);
    const turn = await accept();
    expect((await resolvePatient(turn, label)).outcome).toBe('AMBIGUOUS');
    expect(await snapshots(first.id)).toHaveLength(0);
    expect(await snapshots(second.id)).toHaveLength(0);
    expect(await snapshotId(turn)).toBeNull();
  });

  it('기준 95: 같은 턴의 환자 도구 재시도는 첫 스냅샷을 재사용한다', async () => {
    const patient = await createPatient();
    const turn = await accept();
    await resolved(turn, patient);
    const first = await snapshotId(turn);
    expect(first).toEqual(expect.any(String));
    await resolved(turn, patient);
    expect(await snapshots(patient.id)).toEqual([{ id: first }]);
    expect(await snapshotId(turn)).toBe(first);
  });

  it('기준 96: 게이트 통과 근거 스트림은 지정된 다섯 타입 순서로 흐른다', async () => {
    const events = await evidence(await accept());
    expect(requireEvent(events, 'evidence.gated').abstainReason == null).toBe(true);
    const types = events.map((event) => event.eventType);
    expect(types.join('|')).toMatch(
      /^retrieval\.started\|(retrieval\.progress\|)+evidence\.gated\|(retrieval\.evidence\|)+retrieval\.completed$/,
    );
  });

  it('기준 97: 근거 스트림은 LLM 생성을 호출하지 않는다', async () => {
    const turn = await accept();
    const before = llm.calls;
    const events = await evidence(turn);
    completed(events);
    expect(llm.calls).toBe(before);
  });

  it('기준 98: 근거 스트림 완료 뒤 답변은 빈 STREAMING 상태다', async () => {
    const turn = await accept();
    completed(await evidence(turn));
    await expectStreaming(turn);
  });

  it('기준 99-citations: 근거 스트림은 메시지 인용을 저장하지 않는다', async () => {
    const turn = await accept();
    completed(await evidence(turn));
    const result = await pool.query('SELECT id FROM message_citations WHERE message_id = $1', [
      turn.assistantMessageId,
    ]);
    expect(result.rows).toHaveLength(0);
  });

  it('기준 99-run: 근거 스트림은 생성 이력을 저장하지 않는다', async () => {
    const turn = await accept();
    completed(await evidence(turn));
    const result = await pool.query('SELECT id FROM generation_runs WHERE message_id = $1', [
      turn.assistantMessageId,
    ]);
    expect(result.rows).toHaveLength(0);
  });

  it('기준 100: 관련도 영점인 검색 게이트는 beyond_cutoff로 기권한다', async () => {
    const turn = await accept(abstainApp, abstainCookie);
    const events = await evidence(turn, QUESTION, abstainApp, abstainCookie);
    expect(requireEvent(events, 'evidence.gated').abstainReason).toBe('beyond_cutoff');
  });

  it('기준 101: 검색 게이트 기권 스트림에는 근거 프레임이 없다', async () => {
    const turn = await accept(abstainApp, abstainCookie);
    const events = await evidence(turn, QUESTION, abstainApp, abstainCookie);
    expect(requireEvent(events, 'evidence.gated').abstainReason != null).toBe(true);
    completed(events);
    expect(events.filter((event) => event.eventType === 'retrieval.evidence')).toHaveLength(0);
  });

  it('기준 102: 임베딩 실패는 근거 스트림의 오류 이벤트로 전달한다', async () => {
    const events = await evidence(await accept(), `${QUESTION} ${FAILURE_MARKER}`);
    expect(requireEvent(events, 'error')).toMatchObject({
      code: expect.any(String),
      traceId: expect.any(String),
      retryable: expect.any(Boolean),
    });
  });

  it('기준 103-failure: 근거 도구 실패 뒤에도 답변은 빈 STREAMING 상태다', async () => {
    const turn = await accept();
    requireEvent(await evidence(turn, `${QUESTION} ${FAILURE_MARKER}`), 'error');
    await expectStreaming(turn);
  });

  it('기준 103-disconnect: 근거 연결 중단 뒤에도 답변은 빈 STREAMING 상태다', async () => {
    const turn = await accept();
    const marker = `합성차단표지-${ulid()}`;
    const block = blockControl();
    embedding.blocks.set(marker, block);
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await within(
        fetch(
          `${await app.getUrl()}/api/v1/internal/agent/turns/${turn.assistantMessageId}/guideline-evidence`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...CSRF,
              Cookie: owner.cookie,
            },
            body: JSON.stringify({ query: `${QUESTION} ${marker}` }),
            signal: controller.signal,
          },
        ),
        '근거 스트림 연결',
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      reader = response.body?.getReader();
      if (!reader) throw new Error('근거 스트림 reader가 없습니다.');
      requireEvent(await within(readStarted(reader), '검색 시작 프레임'), 'retrieval.started');
      await within(block.entered.promise, '임베딩 차단 진입');
      controller.abort();
      await reader.cancel().catch(() => undefined);
      block.release.resolve();
      await within(block.returned.promise, '차단 해제 뒤 임베딩 반환');
      // fake 반환을 먼저 관측한다. 이후 비동기 검색·disconnect 정리가 DB에 도달할
      // 기회를 주며 반복 확인한다. 시간 자체를 계약으로 단언하지 않는다.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        await expectStreaming(turn);
      }
    } finally {
      controller.abort();
      block.release.resolve();
      await reader?.cancel().catch(() => undefined);
      embedding.blocks.delete(marker);
    }
  });

  it('기준 104: 검색 질문은 턴 스냅샷의 단일 진단명으로 끝난다', async () => {
    const diagnosis = `합성진단-${ulid()}`;
    const patient = await createPatient(undefined, owner, [diagnosis]);
    const turn = await accept();
    await resolved(turn, patient);
    const gated = requireEvent(await evidence(turn), 'evidence.gated');
    expect(gated.searchQuestion).toEqual(expect.any(String));
    expect((gated.searchQuestion as string).endsWith(diagnosis)).toBe(true);
  });

  it('기준 105: 영문 질문 번역기의 입력에는 한국어 진단명이 없다', async () => {
    const diagnosis = '합성만성허리통증진단';
    const patient = await createPatient(undefined, owner, [diagnosis]);
    const turn = await accept();
    await resolved(turn, patient);
    const before = translator.calls.length;
    const events = await evidence(turn, 'Is acupuncture recommended for chronic low back pain?');
    completed(events);
    const calls = translator.calls.slice(before);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((call) => call.target === 'ko')).toBe(true);
    for (const call of calls) expect(call.text).not.toContain(diagnosis);
  });

  it('기준 118: 환자 삭제는 스냅샷을 사용한 에이전트 대화도 예약한다', async () => {
    const patient = await createPatient();
    const turn = await accept();
    await resolved(turn, patient);
    expect(await deletedAt('conversations', turn.conversationId)).toBeNull();
    await deletePatient(patient.id);
    expect(await deletedAt('conversations', turn.conversationId)).not.toBeNull();
  });

  it('기준 119: 환자 삭제는 그 환자를 쓰지 않은 대화를 보존한다', async () => {
    const patient = await createPatient();
    const used = await accept();
    await resolved(used, patient);
    const unused = await accept();
    expect(await deletedAt('conversations', used.conversationId)).toBeNull();
    expect(await deletedAt('conversations', unused.conversationId)).toBeNull();
    await deletePatient(patient.id);
    expect(await deletedAt('conversations', used.conversationId)).not.toBeNull();
    expect(await deletedAt('conversations', unused.conversationId)).toBeNull();
  });

  it('기준 120: 유예가 지난 대화·환자·턴·스냅샷은 오류 없이 파기된다', async () => {
    const patient = await createPatient();
    const turn = await accept();
    await resolved(turn, patient);
    expect(await snapshotId(turn)).toEqual(expect.any(String));
    expect(await snapshots(patient.id)).toHaveLength(1);
    await deletePatient(patient.id);
    expect(await deletedAt('conversations', turn.conversationId)).not.toBeNull();
    expect(await deletedAt('patients', patient.id)).not.toBeNull();
    for (const [table, id] of [
      ['conversations', turn.conversationId],
      ['patients', patient.id],
    ]) {
      const result = await pool.query(
        `UPDATE ${table} SET deleted_at = now() - interval '400 days' WHERE id = $1`,
        [id],
      );
      expect(result.rowCount).toBe(1);
    }
    // await가 예외 없이 끝나야 아래 물리 삭제 단언에 도달한다.
    await app.get(DataPurgeService).purge();
    // 첫 틱에 대화가 삭제되면 환자 보류가 풀리므로 두 번째 틱에 환자까지 파기한다.
    await app.get(DataPurgeService).purge();
    const conversations = await pool.query('SELECT id FROM conversations WHERE id = $1', [
      turn.conversationId,
    ]);
    const patients = await pool.query('SELECT id FROM patients WHERE id = $1', [patient.id]);
    // messages와 JOIN하지 않는다: 메시지가 사라져도 남은 턴을 숨길 수 없게 id로 조회한다.
    const turns = await pool.query('SELECT message_id FROM agent_turns WHERE message_id = $1', [
      turn.assistantMessageId,
    ]);
    expect(conversations.rows).toHaveLength(0);
    expect(patients.rows).toHaveLength(0);
    expect(turns.rows).toHaveLength(0);
    expect(await snapshots(patient.id)).toHaveLength(0);
  });
});
