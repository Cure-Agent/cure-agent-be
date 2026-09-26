// docs/specs/55 수용 기준 1~17 동결 테스트 — 구현 중 수정 금지
// 기준 18은 test/contract/openapi-sync.e2e-spec.ts에 있다.
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
import { FinishAgentTurnRequestDto } from '../src/domain/agent-turn/dto/request/finish-agent-turn.request.dto';
import { AgentTurnFinishResponseDto } from '../src/domain/agent-turn/dto/response/agent-turn-finish.response.dto';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { EMBEDDING_PROVIDER } from '../src/infrastructure/embedding/embedding-provider.port';
import { FakeEmbeddingProvider } from '../src/infrastructure/embedding/fake-embedding.provider';
import {
  GUIDANCE_STRUCTURER, GuidanceStructurer, GuidanceStructureRequest, GuidanceStructureResult,
} from '../src/infrastructure/llm/guidance/guidance-structurer.port';
import {
  LLM_PROVIDERS, LlmProvider, LlmStreamRequest, LlmAnswerChunk,
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

const CSRF = { 'X-CSRF-Protection': '1' };
const ANSWER = '합성 기록의 검토 항목을 정리한 가상 답변입니다.';
const LONG_QUESTION = `🧪 합성  기록\n검토\t${'가'.repeat(45)} 끝  `;
const BACKFILL_PATH = join(__dirname, '..', 'drizzle', 'migrations', '0029_agent_turn_title_backfill.sql');
const DEFAULT_TITLE = { title: '새 대화', title_source: 'DEFAULT' };

// 제품 유틸을 사용하지 않는 명세의 독립 오라클이다.
function expectedTitle(question: string): string {
  const points = Array.from(question.replace(/\s+/g, ' ').trim());
  return points.length > 40 ? `${points.slice(0, 40).join('')}…` : points.join('');
}

function assertLongQuestion(question: string): void {
  expect([...question].length).toBeGreaterThan(40);
  expect(question.slice(0, 40)).not.toBe([...question].slice(0, 40).join(''));
  const cleaned = question.replace(/\s+/g, ' ').trim();
  expect([...cleaned].length).toBeGreaterThan(40);
  expect(cleaned.slice(0, 40)).not.toBe([...cleaned].slice(0, 40).join(''));
  expect([...expectedTitle(question)]).toHaveLength(41);
}

function shortQuestion(): string {
  const question = `CASE-${ulid().slice(-6)} 합성 검토 항목은?`;
  expect([...question].length).toBeLessThanOrEqual(40);
  return question;
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class ControlledStructurer implements GuidanceStructurer {
  readonly model = 'spec55-controlled-structurer';
  mode: 'valid' | 'blocked' = 'valid';
  calls = 0;
  block?: { entered: ReturnType<typeof latch>; release: ReturnType<typeof latch> };

  async structure(input: GuidanceStructureRequest): Promise<GuidanceStructureResult> {
    this.calls += 1;
    if (this.mode === 'blocked') {
      const block = this.block;
      if (!block) throw new Error('구조화 래치가 없습니다.');
      block.entered.resolve();
      await block.release.promise;
    }
    return {
      considerations: input.evidence.map((item) => ({
        title: '합성 적용 검토',
        rationale: '합성 진단 기록과 근거의 조건을 대조하는 가상 항목입니다.',
        applicability: 'CAUTION', markers: [item.marker], patientFactors: ['진단명'],
      })),
    };
  }
}

class SyntheticLlm implements LlmProvider {
  readonly name = 'spec55-fake-llm';
  async *streamAnswer(_input: LlmStreamRequest): AsyncIterable<LlmAnswerChunk> {
    yield { kind: 'verdict', insufficientEvidence: false, missingAspects: [] };
    yield { kind: 'delta', text: '합성 검토 답변 [1].' };
  }
}

class SyntheticTranslator implements Translator {
  readonly model = 'spec55-fake-translator';
  translate(text: string, target: SupportedLang): Promise<string> {
    return Promise.resolve(`[${target}] ${text}`);
  }
}

class SyntheticReranker implements Reranker {
  readonly model = 'spec55-fake-reranker';
  rerank(_question: string, candidates: RerankCandidate[]): Promise<RerankResult> {
    return Promise.resolve({ order: candidates.map((item) => item.chunkId), top1Relevance: 10 });
  }
}

interface AcceptedTurn {
  userMessageId: string;
  assistantMessageId: string;
}

interface Turn extends AcceptedTurn {
  conversationId: string;
}

interface TitleRow {
  title: string;
  title_source: string;
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

function completedBody(): FinishAgentTurnRequestDto {
  return { status: 'COMPLETED', route: 'COMPOSITE', content: ANSWER };
}

describe('docs/specs/55: 에이전트 완결의 자동 제목 BE 수용 기준', () => {
  jest.setTimeout(180_000);
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let owner: TestSession;
  let evidenceId: string;
  const structurer = new ControlledStructurer();
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
      .overrideProvider(LLM_PROVIDERS).useValue([new SyntheticLlm()])
      .overrideProvider(RERANKER).useValue(new SyntheticReranker())
      .overrideProvider(TRANSLATOR).useValue(new SyntheticTranslator())
      .overrideProvider(GUIDANCE_STRUCTURER).useValue(structurer)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);
    const ingested = await app.get(GuidelineIngestService).ingest(compositeGuidanceSample);
    const evidence = await pool.query<{ id: string }>(
      'SELECT id FROM evidence_chunks WHERE guideline_version_id = $1 ORDER BY id',
      [ingested.guidelineVersionId],
    );
    expect(evidence.rows.length).toBeGreaterThan(0);
    evidenceId = requireString(evidence.rows[0].id);
    owner = await socialSignUp(app, {
      email: 'spec55-owner@clinic.kr', providerId: 'spec55-owner',
      clinicName: '합성 자동 제목 클리닉', licenseNumber: 'spec55-owner-license',
    });
  });

  beforeEach(() => {
    structurer.mode = 'valid';
    structurer.calls = 0;
    structurer.block = undefined;
  });

  afterEach(() => { structurer.block?.release.resolve(); });

  afterAll(async () => {
    structurer.block?.release.resolve();
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

  async function createConversation(): Promise<string> {
    const response = await post('/api/v1/conversations')
      .send({ type: 'GUIDELINE_QA' }).expect(201);
    return requireString(dataOf<{ id: string }>(response).id);
  }

  async function accept(conversationId: string, content: string): Promise<AcceptedTurn> {
    const response = await post(`/api/v1/internal/agent/conversations/${conversationId}/turns`)
      .send({ content, clientRequestId: randomUUID() }).expect(201);
    const data = dataOf<AcceptedTurn>(response);
    return {
      userMessageId: requireString(data.userMessageId),
      assistantMessageId: requireString(data.assistantMessageId),
    };
  }

  async function freshTurn(question: string): Promise<Turn> {
    const conversationId = await createConversation();
    return { conversationId, ...(await accept(conversationId, question)) };
  }

  function finishRequest(turn: Turn, body: FinishAgentTurnRequestDto = completedBody()) {
    return post(`/api/v1/internal/agent/turns/${turn.assistantMessageId}/finish`).send(body);
  }

  async function finish(turn: Turn, body: FinishAgentTurnRequestDto = completedBody()) {
    const data = dataOf<AgentTurnFinishResponseDto>(await finishRequest(turn, body).expect(200));
    expect(data.id).toBe(turn.assistantMessageId);
    expect(data.status).toBe(body.status);
    return data;
  }

  async function titleOf(conversationId: string): Promise<string> {
    const response = await request(app.getHttpServer()).get(`/api/v1/conversations/${conversationId}`)
      .set('Cookie', owner.cookie).expect(200);
    return requireString(dataOf<{ title: string }>(response).title);
  }

  async function titleRow(conversationId: string): Promise<TitleRow> {
    const result = await pool.query<TitleRow>(
      'SELECT title, title_source FROM conversations WHERE id = $1', [conversationId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  }

  async function expectDefault(conversationId: string): Promise<void> {
    expect(await titleRow(conversationId)).toEqual(DEFAULT_TITLE);
  }

  async function rename(conversationId: string, title: string): Promise<void> {
    const response = await request(app.getHttpServer()).patch(`/api/v1/conversations/${conversationId}`)
      .set(CSRF).set('Cookie', owner.cookie).send({ title }).expect(200);
    expect(dataOf<{ title: string }>(response).title).toBe(title);
    expect(await titleRow(conversationId)).toEqual({ title, title_source: 'USER' });
  }

  // 각 부정 기준이 자기 it 안에서 별도의 새 대화로 양성 대조를 만든다.
  async function runtimeControl(body: FinishAgentTurnRequestDto): Promise<void> {
    const question = shortQuestion();
    const control = await freshTurn(question);
    await expectDefault(control.conversationId);
    await finish(control, body);
    expect(await titleOf(control.conversationId)).toBe(question);
    expect(await titleRow(control.conversationId)).toEqual({ title: question, title_source: 'AUTO' });
  }

  async function pinnedTurn(question: string): Promise<Turn> {
    const caseLabel = `CASE-${ulid()}`;
    const fields = {
      diagnoses: [`합성진단-${ulid()}`], medications: [`합성약물-${ulid()}`],
      allergies: [`합성알레르기-${ulid()}`],
    };
    const created = await post('/api/v1/patients').send({ caseLabel, ...fields }).expect(201);
    const patientId = requireString(dataOf<{ id: string }>(created).id);
    const turn = await freshTurn(question);
    const resolved = await post(`/api/v1/internal/agent/turns/${turn.assistantMessageId}/patient`)
      .send({ caseLabel }).expect(200);
    expect(dataOf(resolved)).toMatchObject({ outcome: 'RESOLVED', patient: { id: patientId, ...fields } });
    const pinned = await pool.query<{ patient_snapshot_id: string | null }>(
      'SELECT patient_snapshot_id FROM agent_turns WHERE message_id = $1', [turn.assistantMessageId],
    );
    expect(pinned.rows).toHaveLength(1);
    requireString(pinned.rows[0].patient_snapshot_id);
    await expectDefault(turn.conversationId);
    return turn;
  }

  function citedBody(): FinishAgentTurnRequestDto {
    return {
      ...completedBody(), content: '합성 기록과 검토 근거를 대조한 가상 답변 [1].',
      citations: [{ marker: 1, evidenceId }],
    };
  }

  // 백필 시드는 완결을 호출하지 않는다. 구현 후에도 DEFAULT에서 SQL의 효과를 관측한다.
  async function setRoute(turn: AcceptedTurn): Promise<void> {
    const result = await pool.query(
      "UPDATE agent_turns SET route = 'COMPOSITE' WHERE message_id = $1",
      [turn.assistantMessageId],
    );
    expect(result.rowCount).toBe(1);
  }

  async function seedRoutedConversation(question: string): Promise<Turn> {
    const turn = await freshTurn(question);
    await setRoute(turn);
    await expectDefault(turn.conversationId);
    return turn;
  }

  async function runBackfill(): Promise<void> {
    const statements = readFileSync(BACKFILL_PATH, 'utf8')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) await pool.query(statement);
  }

  async function expectBackfilled(control: Turn, question: string): Promise<void> {
    expect(await titleRow(control.conversationId)).toEqual({
      title: expectedTitle(question), title_source: 'AUTO',
    });
  }

  it('기준 1: COMPOSITE 완료 뒤 상세 제목은 그 턴의 짧은 질문이다', async () => {
    const question = shortQuestion();
    expect([...question].length).toBeLessThanOrEqual(40);
    const turn = await freshTurn(question);
    expect(await titleOf(turn.conversationId)).toBe('새 대화');
    await finish(turn);
    expect(await titleOf(turn.conversationId)).toBe(question);
  });

  it('기준 2: COMPOSITE 완료가 기본 제목 출처를 AUTO로 바꾼다', async () => {
    const turn = await freshTurn(shortQuestion());
    expect((await titleRow(turn.conversationId)).title_source).toBe('DEFAULT');
    await finish(turn);
    expect((await titleRow(turn.conversationId)).title_source).toBe('AUTO');
  });

  it('기준 3: 긴 질문은 공백을 접고 BMP 밖 문자를 포함한 40 코드포인트와 …로 자른다', async () => {
    const question = LONG_QUESTION;
    assertLongQuestion(question);
    const turn = await freshTurn(question);
    await expectDefault(turn.conversationId);
    await finish(turn);
    expect(await titleOf(turn.conversationId)).toBe(expectedTitle(question));
  });

  it('기준 4: PATIENT 완료도 질문으로 제목을 붙인다', async () => {
    const question = shortQuestion();
    const turn = await freshTurn(question);
    await expectDefault(turn.conversationId);
    await finish(turn, { status: 'COMPLETED', route: 'PATIENT', content: ANSWER });
    expect(await titleOf(turn.conversationId)).toBe(question);
  });

  it('기준 5: OTHER 기권도 질문으로 제목을 붙인다', async () => {
    const question = shortQuestion();
    const turn = await freshTurn(question);
    await expectDefault(turn.conversationId);
    await finish(turn, { status: 'ABSTAINED', route: 'OTHER', abstainReason: 'out_of_scope' });
    expect(await titleOf(turn.conversationId)).toBe(question);
  });

  it('기준 6: COMPOSITE 실패도 질문으로 제목을 붙인다', async () => {
    const question = shortQuestion();
    const turn = await freshTurn(question);
    await expectDefault(turn.conversationId);
    await finish(turn, { status: 'FAILED', route: 'COMPOSITE' });
    expect(await titleOf(turn.conversationId)).toBe(question);
  });

  it('기준 7: 완결 뒤 대화 목록의 제목도 그 턴의 질문이다', async () => {
    const question = shortQuestion();
    const turn = await freshTurn(question);
    await expectDefault(turn.conversationId);
    await finish(turn);
    let cursor: string | undefined;
    let found: { id: string; title: string } | undefined;
    const visited = new Set<string>();
    do {
      const response = await request(app.getHttpServer()).get('/api/v1/conversations')
        .query(cursor ? { size: 50, cursor } : { size: 50 })
        .set('Cookie', owner.cookie).expect(200);
      const rows = dataOf<{ id: string; title: string }[]>(response);
      expect(Array.isArray(rows)).toBe(true);
      found = rows.find((row) => row.id === turn.conversationId);
      if (found) break;
      const page = response.body.page as { hasNext: boolean; nextCursor: string | null };
      if (!page.hasNext) break;
      cursor = requireString(page.nextCursor);
      expect(visited.has(cursor)).toBe(false);
      visited.add(cursor);
    } while (cursor);
    expect(found).toBeDefined();
    expect(found?.title).toBe(question);
  });

  it('기준 8-title: route 없는 실패는 기본 제목을 보존한다', async () => {
    await runtimeControl({ status: 'FAILED', route: 'COMPOSITE' });
    const subject = await freshTurn(shortQuestion());
    await expectDefault(subject.conversationId);
    await finish(subject, { status: 'FAILED' });
    expect(await titleOf(subject.conversationId)).toBe('새 대화');
  });

  it('기준 8-source: route 없는 실패는 DEFAULT 출처를 보존한다', async () => {
    await runtimeControl({ status: 'FAILED', route: 'COMPOSITE' });
    const subject = await freshTurn(shortQuestion());
    await expectDefault(subject.conversationId);
    await finish(subject, { status: 'FAILED' });
    expect((await titleRow(subject.conversationId)).title_source).toBe('DEFAULT');
  });

  it('기준 9: 수락 직후 기본 제목이며 경로 있는 완결 뒤에만 제목이 선다', async () => {
    const question = shortQuestion();
    const conversationId = await createConversation();
    await expectDefault(conversationId);
    const accepted = await accept(conversationId, question);
    // 완결을 보내기 전에 수락만으로는 제목이 서지 않았음을 관측한다.
    expect(await titleOf(conversationId)).toBe('새 대화');
    await expectDefault(conversationId);
    await finish({ conversationId, ...accepted });
    expect(await titleOf(conversationId)).toBe(question);
    expect((await titleRow(conversationId)).title_source).toBe('AUTO');
  });

  it('기준 10: 첫 완결이 만든 AUTO 제목을 두 번째 질문이 덮지 않는다', async () => {
    const q1 = '합성 첫 질문의 검토 항목은?';
    const q2 = '합성 두 번째 질문의 확인 항목은?';
    expect(q1).not.toBe(q2);
    expect([...q1].length).toBeLessThanOrEqual(40);
    expect([...q2].length).toBeLessThanOrEqual(40);
    const first = await freshTurn(q1);
    await expectDefault(first.conversationId);
    await finish(first);
    expect(await titleOf(first.conversationId)).toBe(q1);
    expect(await titleRow(first.conversationId)).toEqual({ title: q1, title_source: 'AUTO' });
    const second = await accept(first.conversationId, q2);
    await finish({ conversationId: first.conversationId, ...second });
    const title = await titleOf(first.conversationId);
    expect(title).toBe(q1);
    expect(title).not.toBe(q2);
    expect((await titleRow(first.conversationId)).title_source).toBe('AUTO');
  });

  it('기준 11: 수락 뒤 PATCH한 USER 제목을 완결이 덮지 않는다', async () => {
    await runtimeControl(completedBody());
    const question = shortQuestion();
    const userTitle = '합성 사용자가 지정한 검토 제목';
    expect(userTitle).not.toBe(question);
    const turn = await freshTurn(question);
    await rename(turn.conversationId, userTitle);
    await finish(turn);
    expect(await titleOf(turn.conversationId)).toBe(userTitle);
    expect(await titleRow(turn.conversationId)).toEqual({ title: userTitle, title_source: 'USER' });
  });

  it('기준 12: 구조화 중 route 없는 취소에 진 완결은 기본 제목을 보존한다', async () => {
    const question = shortQuestion();
    const turn = await pinnedTurn(question);
    const block = { entered: latch(), release: latch() };
    structurer.block = block;
    structurer.mode = 'blocked';
    // then으로 지연 요청을 시작한다. 타임아웃은 교착 방지용이며 시간을 단언하지 않는다.
    const pending = finishRequest(turn, citedBody()).timeout({ deadline: 15_000 })
      .then((response) => response);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        block.entered.promise,
        pending.then(() => { throw new Error('구조화 래치 진입 전에 완결됐습니다.'); }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('구조화 래치에 진입하지 않았습니다.')), 10_000);
        }),
      ]);
      clearTimeout(timer);
      // route를 보내면 이 취소 자체가 제목을 붙이므로 반드시 키를 생략한다.
      const cancelled = await finishRequest(turn, { status: 'CANCELLED' })
        .timeout({ deadline: 10_000 }).expect(200);
      expect(dataOf<AgentTurnFinishResponseDto>(cancelled).status).toBe('CANCELLED');
      block.release.resolve();
      const losing = await pending;
      expect(losing.status).toBe(409);
      expect(losing.body).toMatchObject({ success: false, code: 'AGENT_TURN_CLOSED' });
      expect((await pool.query(
        'SELECT status, content FROM messages WHERE id = $1', [turn.assistantMessageId],
      )).rows).toEqual([{ status: 'CANCELLED', content: '' }]);
      expect(await titleOf(turn.conversationId)).toBe('새 대화');
      await expectDefault(turn.conversationId);
    } finally {
      clearTimeout(timer);
      block.release.resolve();
      await pending.catch(() => undefined);
      structurer.mode = 'valid';
      structurer.block = undefined;
    }

    // 같은 환자 스냅샷 + 인용 fixture의 정상 완결이 양성 대조다.
    const controlQuestion = shortQuestion();
    const control = await pinnedTurn(controlQuestion);
    const before = structurer.calls;
    await finish(control, citedBody());
    expect(structurer.calls).toBe(before + 1);
    expect(await titleOf(control.conversationId)).toBe(controlQuestion);
    expect((await titleRow(control.conversationId)).title_source).toBe('AUTO');
  });

  it('기준 13-title: 백필은 긴 첫 질문을 공백 접기와 40 코드포인트 규칙으로 제목에 쓴다', async () => {
    const question = LONG_QUESTION;
    assertLongQuestion(question);
    const turn = await seedRoutedConversation(question);
    await expectDefault(turn.conversationId);
    await runBackfill();
    expect(await titleOf(turn.conversationId)).toBe(expectedTitle(question));
  });

  it('기준 13-source: 백필은 대상 대화의 출처를 DEFAULT에서 AUTO로 바꾼다', async () => {
    assertLongQuestion(LONG_QUESTION);
    const turn = await seedRoutedConversation(LONG_QUESTION);
    await expectDefault(turn.conversationId);
    await runBackfill();
    expect((await titleRow(turn.conversationId)).title_source).toBe('AUTO');
  });

  it('기준 14: 두 턴 백필의 제목 원천은 id 오름차순 첫 USER 메시지다', async () => {
    const q1 = '  합성 첫  질문\n검토 항목은?  ';
    const q2 = '합성 두 번째 질문의 다른 항목은?';
    expect(expectedTitle(q1)).not.toBe(expectedTitle(q2));
    const first = await seedRoutedConversation(q1);
    const second = await accept(first.conversationId, q2);
    await setRoute(second);
    const users = await pool.query<{ id: string; content: string }>(
      "SELECT id, content FROM messages WHERE conversation_id = $1 AND role = 'USER' ORDER BY id ASC",
      [first.conversationId],
    );
    expect(users.rows).toEqual([
      { id: first.userMessageId, content: q1 },
      { id: second.userMessageId, content: q2 },
    ]);
    const routes = await pool.query<{ route: string | null }>(
      'SELECT route FROM agent_turns WHERE message_id = ANY($1::text[])',
      [[first.assistantMessageId, second.assistantMessageId]],
    );
    expect(routes.rows).toEqual([{ route: 'COMPOSITE' }, { route: 'COMPOSITE' }]);
    await expectDefault(first.conversationId);
    await runBackfill();
    const title = await titleOf(first.conversationId);
    expect(title).toBe(expectedTitle(q1));
    expect(title).not.toBe(expectedTitle(q2));
  });

  it('기준 15: 백필은 메시지 0건인 기본 제목 대화를 보존한다', async () => {
    const control = await seedRoutedConversation(LONG_QUESTION);
    const subject = await createConversation();
    expect((await pool.query('SELECT id FROM messages WHERE conversation_id = $1', [subject])).rows)
      .toHaveLength(0);
    await expectDefault(control.conversationId);
    await expectDefault(subject);
    await runBackfill();
    await expectBackfilled(control, LONG_QUESTION);
    expect(await titleRow(subject)).toEqual(DEFAULT_TITLE);
  });

  it('기준 16: 백필은 route가 NULL인 턴만 가진 기본 제목 대화를 보존한다', async () => {
    const control = await seedRoutedConversation(LONG_QUESTION);
    const subject = await freshTurn(shortQuestion());
    const routes = await pool.query<{ route: string | null }>(
      `SELECT t.route FROM agent_turns t JOIN messages m ON m.id = t.message_id
       WHERE m.conversation_id = $1`, [subject.conversationId],
    );
    expect(routes.rows).toEqual([{ route: null }]);
    await expectDefault(control.conversationId);
    await expectDefault(subject.conversationId);
    await runBackfill();
    await expectBackfilled(control, LONG_QUESTION);
    expect(await titleRow(subject.conversationId)).toEqual(DEFAULT_TITLE);
  });

  it('기준 17-user: 백필은 경로 있는 턴이 있어도 PATCH한 USER 제목을 보존한다', async () => {
    const control = await seedRoutedConversation(LONG_QUESTION);
    const question = shortQuestion();
    const subject = await seedRoutedConversation(question);
    const userTitle = '합성 사용자 지정 백필 제외 제목';
    expect(userTitle).not.toBe(expectedTitle(question));
    await rename(subject.conversationId, userTitle);
    await expectDefault(control.conversationId);
    await runBackfill();
    await expectBackfilled(control, LONG_QUESTION);
    expect(await titleRow(subject.conversationId)).toEqual({ title: userTitle, title_source: 'USER' });
  });

  it('기준 17-auto: 백필은 첫 질문과 다른 기존 AUTO 제목을 보존한다', async () => {
    const control = await seedRoutedConversation(LONG_QUESTION);
    const question = shortQuestion();
    const subject = await seedRoutedConversation(question);
    const autoTitle = '합성 기존 자동 제목 백필 제외';
    expect(autoTitle).not.toBe(expectedTitle(question));
    expect((await pool.query(
      "UPDATE conversations SET title = $1, title_source = 'AUTO' WHERE id = $2",
      [autoTitle, subject.conversationId],
    )).rowCount).toBe(1);
    expect(await titleRow(subject.conversationId)).toEqual({ title: autoTitle, title_source: 'AUTO' });
    await expectDefault(control.conversationId);
    await runBackfill();
    await expectBackfilled(control, LONG_QUESTION);
    expect(await titleRow(subject.conversationId)).toEqual({ title: autoTitle, title_source: 'AUTO' });
  });
});
