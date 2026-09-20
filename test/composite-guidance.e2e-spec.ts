// docs/specs/54 수용 기준 1~38 동결 테스트 — 구현 중 수정 금지
// 기준 36은 test/contract/openapi-sync.e2e-spec.ts에 있다.
import { randomUUID } from 'node:crypto';
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
import { ClinicalGuidanceResponseDto } from '../src/domain/clinical-guidance/dto/response/clinical-guidance.response.dto';
import { MessageResponseDto } from '../src/domain/conversation/dto/response/message.response.dto';
import { DataPurgeService } from '../src/domain/data-purge/service/data-purge.service';
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
const ANSWER = '합성 기록과 첫 번째 검토 근거를 대조합니다 [3].\n두 번째 합성 근거도 검토 대상으로 남깁니다 [8].';

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class ControlledStructurer implements GuidanceStructurer {
  readonly model = 'spec54-controlled-structurer';
  mode: 'valid' | 'throw' | 'invalid' | 'disabled' | 'blocked' = 'valid';
  readonly inputs: GuidanceStructureRequest[] = [];
  block?: { entered: ReturnType<typeof latch>; release: ReturnType<typeof latch> };
  get disabled(): boolean { return this.mode === 'disabled'; }
  get calls(): number { return this.inputs.length; }

  async structure(input: GuidanceStructureRequest): Promise<GuidanceStructureResult> {
    this.inputs.push({
      ...input,
      evidence: input.evidence.map((item) => ({ ...item, sectionPath: [...item.sectionPath] })),
      profileFields: input.profileFields.map((item) => ({ ...item })),
    });
    const mode = this.mode;
    if (mode === 'throw') throw new Error('Spec54 의도된 구조화 예외');
    if (mode === 'blocked') {
      const block = this.block;
      if (!block) throw new Error('구조화 래치가 없습니다.');
      block.entered.resolve();
      await block.release.promise;
    }
    return {
      considerations: input.evidence.map((item) => ({
        title: '합성 적용 검토',
        rationale: '합성 진단 기록과 이 근거의 조건을 대조한 검토 항목입니다.',
        applicability: 'CAUTION',
        markers: [mode === 'invalid' ? 999999 : item.marker],
        patientFactors: ['진단명'],
      })),
    };
  }
}

class SyntheticLlm implements LlmProvider {
  readonly name = 'spec54-fake-llm';
  async *streamAnswer(_input: LlmStreamRequest): AsyncIterable<LlmAnswerChunk> {
    yield { kind: 'verdict', insufficientEvidence: false, missingAspects: [] };
    yield { kind: 'delta', text: '합성 검토 답변 [1].' };
  }
}

class SyntheticTranslator implements Translator {
  readonly model = 'spec54-fake-translator';
  translate(text: string, target: SupportedLang): Promise<string> {
    return Promise.resolve(`[${target}] ${text}`);
  }
}

class SyntheticReranker implements Reranker {
  readonly model = 'spec54-fake-reranker';
  rerank(_question: string, candidates: RerankCandidate[]): Promise<RerankResult> {
    return Promise.resolve({ order: candidates.map((item) => item.chunkId), top1Relevance: 10 });
  }
}

interface Turn {
  conversationId: string;
  assistantMessageId: string;
  session: TestSession;
}

interface GuidanceRow {
  id: string;
  patient_id: string;
  patient_snapshot_id: string;
  composer_version: string;
}

interface EvidenceRow {
  id: string;
  content: string;
  title: string;
  path: string[];
}

function requireString(value: unknown): string {
  expect(value).toEqual(expect.any(String));
  if (typeof value !== 'string' || !value) throw new Error('비어 있지 않은 문자열이 필요합니다.');
  return value;
}

function dataOf<T>(response: SupertestResponse): T {
  expect(response.body).toMatchObject({ success: true });
  return response.body.data as T;
}

function guidanceOf(data: AgentTurnFinishResponseDto): ClinicalGuidanceResponseDto {
  expect(data).toHaveProperty('guidance');
  expect(data.guidance).toBeDefined();
  if (!data.guidance) throw new Error('복합 완결 참고안이 없습니다.');
  return data.guidance;
}

function expectError(response: SupertestResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
  expect(response.body).toMatchObject({ success: false, code });
}

describe('docs/specs/54: 복합 답변 참고안 BE 수용 기준', () => {
  jest.setTimeout(180_000);
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let owner: TestSession;
  let evidence: EvidenceRow[];
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
    evidence = (await pool.query<EvidenceRow>(
      `SELECT e.id, e.content, g.title, s.path FROM evidence_chunks e
       JOIN guideline_sections s ON s.id = e.section_id
       JOIN guideline_versions v ON v.id = e.guideline_version_id
       JOIN guidelines g ON g.id = v.guideline_id
       WHERE e.guideline_version_id = $1 ORDER BY s."order", e."order"`,
      [ingested.guidelineVersionId],
    )).rows;
    expect(evidence).toHaveLength(2);
    owner = await socialSignUp(app, {
      email: 'spec54-owner@clinic.kr', providerId: 'spec54-owner',
      clinicName: '합성 복합 참고안 클리닉', licenseNumber: 'spec54-owner-license',
    });
  });

  beforeEach(() => {
    structurer.mode = 'valid';
    structurer.inputs.length = 0;
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

  const post = (path: string, session = owner) =>
    request(app.getHttpServer()).post(path).set(CSRF).set('Cookie', session.cookie);

  async function freshTurn(session = owner, responseLang?: 'ko' | 'en'): Promise<Turn> {
    const conversation = await post('/api/v1/conversations', session)
      .send({ type: 'GUIDELINE_QA' }).expect(201);
    const conversationId = requireString(dataOf<{ id: string }>(conversation).id);
    const accepted = await post(`/api/v1/internal/agent/conversations/${conversationId}/turns`, session)
      .send({ content: `합성 사례의 중재 검토 질문 ${ulid()}`, clientRequestId: randomUUID(), responseLang })
      .expect(201);
    return {
      conversationId, session,
      assistantMessageId: requireString(dataOf<{ assistantMessageId: string }>(accepted).assistantMessageId),
    };
  }

  async function pinnedTurn(session = owner, responseLang?: 'ko' | 'en') {
    const fields = {
      diagnoses: [`합성진단-${ulid()}`], medications: [`합성약물-${ulid()}`],
      allergies: [`합성알레르기-${ulid()}`], clinicalNotes: `합성 임상 메모 ${ulid()}`,
    };
    const caseLabel = `Spec54-${ulid()}`;
    const created = await post('/api/v1/patients', session).send({ caseLabel, ...fields }).expect(201);
    const patientId = requireString(dataOf<{ id: string }>(created).id);
    const turn = await freshTurn(session, responseLang);
    const resolved = await post(`/api/v1/internal/agent/turns/${turn.assistantMessageId}/patient`, session)
      .send({ caseLabel }).expect(200);
    expect(dataOf(resolved)).toMatchObject({ outcome: 'RESOLVED', patient: { id: patientId, ...fields } });
    const rows = (await pool.query<{ patient_snapshot_id: string }>(
      'SELECT patient_snapshot_id FROM agent_turns WHERE message_id = $1', [turn.assistantMessageId],
    )).rows;
    expect(rows).toHaveLength(1);
    return { ...turn, patientId, fields, snapshotId: requireString(rows[0].patient_snapshot_id) };
  }

  function compositeBody(): FinishAgentTurnRequestDto {
    return {
      status: 'COMPLETED', route: 'COMPOSITE', content: ANSWER,
      citations: [{ marker: 3, evidenceId: evidence[0].id }, { marker: 8, evidenceId: evidence[1].id }],
      generation: {
        provider: 'spec54-provider', model: 'spec54-model', promptVersion: 'spec54-synthesis-v1',
        latencyMs: 1, inputTokens: 10, outputTokens: 10,
        retrievalPolicyVersion: 'spec54-retrieval-v1', searchQuestion: '합성 검색 질문',
      },
    };
  }

  function finishRequest(turn: Turn, body = compositeBody()) {
    return post(`/api/v1/internal/agent/turns/${turn.assistantMessageId}/finish`, turn.session).send(body);
  }

  async function finish(turn: Turn, body = compositeBody()): Promise<AgentTurnFinishResponseDto> {
    const response = await finishRequest(turn, body).expect(200);
    const data = dataOf<AgentTurnFinishResponseDto>(response);
    expect(data.id).toBe(turn.assistantMessageId);
    return data;
  }

  async function guidanceRows(turn: Turn): Promise<GuidanceRow[]> {
    return (await pool.query<GuidanceRow>(
      'SELECT id, patient_id, patient_snapshot_id, composer_version FROM clinical_guidances WHERE message_id = $1',
      [turn.assistantMessageId],
    )).rows;
  }

  async function oneGuidance(turn: Turn): Promise<GuidanceRow> {
    const rows = await guidanceRows(turn);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  function inputOf(index = 0): GuidanceStructureRequest {
    expect(structurer.inputs[index]).toBeDefined();
    return structurer.inputs[index];
  }

  // 부정 기준의 대조는 각 it 안에서 호출한다. 공유 beforeAll의 성공으로 대신하지 않는다.
  async function callControl(): Promise<void> {
    const before = structurer.calls;
    await finish(await pinnedTurn());
    expect(structurer.calls).toBe(before + 1);
  }

  async function rowControl() {
    const turn = await pinnedTurn();
    const data = await finish(turn);
    const row = await oneGuidance(turn);
    return { turn, data, row };
  }

  async function review(guidanceId: string, session = owner) {
    const response = await post(`/api/v1/clinical-guidance/${guidanceId}/reviews`, session)
      .send({ decision: 'ACCEPTED', note: '합성 참고안 검토 기록' }).expect(200);
    expect(dataOf<ClinicalGuidanceResponseDto>(response).reviewStatus).toBe('ACCEPTED');
    const rows = (await pool.query<{ id: string; decision: string }>(
      'SELECT id, decision FROM guidance_reviews WHERE guidance_id = $1', [guidanceId],
    )).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('ACCEPTED');
    return rows[0].id;
  }

  it('기준 1: 복합 완료 응답 data에 guidance가 있다', async () => {
    const data = await finish(await pinnedTurn());
    expect('guidance' in data).toBe(true);
    guidanceOf(data);
  });

  it('기준 2: 새 복합 참고안은 DRAFT다', async () => {
    expect(guidanceOf(await finish(await pinnedTurn())).reviewStatus).toBe('DRAFT');
  });

  it('기준 3: 복합 완료 메시지의 참고안은 정확히 한 행이다', async () => {
    const turn = await pinnedTurn();
    await finish(turn);
    expect(await guidanceRows(turn)).toHaveLength(1);
  });

  it('기준 4: 참고안은 환자 도구가 턴에 고정한 스냅샷을 가리킨다', async () => {
    const turn = await pinnedTurn();
    await finish(turn);
    const pinned = (await pool.query<{ patient_snapshot_id: string }>(
      'SELECT patient_snapshot_id FROM agent_turns WHERE message_id = $1', [turn.assistantMessageId],
    )).rows;
    expect(pinned).toEqual([{ patient_snapshot_id: turn.snapshotId }]);
    expect((await oneGuidance(turn)).patient_snapshot_id).toBe(pinned[0].patient_snapshot_id);
  });

  it('기준 5: 참고안의 환자는 환자 도구와 스냅샷의 환자다', async () => {
    const turn = await pinnedTurn();
    await finish(turn);
    const snapshot = (await pool.query<{ patient_id: string }>(
      'SELECT patient_id FROM patient_profile_snapshots WHERE id = $1', [turn.snapshotId],
    )).rows;
    expect(snapshot).toEqual([{ patient_id: turn.patientId }]);
    expect((await oneGuidance(turn)).patient_id).toBe(snapshot[0].patient_id);
  });

  it('기준 6: 구조화 answerText는 완결 content 그대로다', async () => {
    const body = compositeBody();
    await finish(await pinnedTurn(), body);
    expect(structurer.calls).toBe(1);
    expect(inputOf().answerText).toBe(body.content);
  });

  it('기준 7: 구조화 근거 마커는 완결 인용 마커 집합과 같다', async () => {
    const body = compositeBody();
    await finish(await pinnedTurn(), body);
    expect(new Set(inputOf().evidence.map((item) => item.marker)))
      .toEqual(new Set(body.citations!.map((item) => item.marker)));
  });

  it('기준 8: 구조화 근거는 120자 발췌가 아닌 청크 원문 전체다', async () => {
    const body = compositeBody();
    const data = await finish(await pinnedTurn(), body);
    for (const citation of body.citations!) {
      const rows = (await pool.query<{ content: string }>(
        'SELECT content FROM evidence_chunks WHERE id = $1', [citation.evidenceId],
      )).rows;
      expect(rows).toHaveLength(1);
      const original = rows[0].content;
      const saved = data.citations.find((item) => item.marker === citation.marker);
      expect(saved).toBeDefined();
      expect(original.length).toBeGreaterThan(120);
      expect(original).not.toBe(saved?.quote);
      expect(saved?.quote).toBe(original.slice(0, 120) + '…');
      expect(inputOf().evidence.find((item) => item.marker === citation.marker)?.content).toBe(original);
    }
  });

  it('기준 9-title: 구조화 근거에 청크가 속한 지침 제목을 싣는다', async () => {
    await finish(await pinnedTurn());
    expect(inputOf().evidence).toHaveLength(2);
    for (const [index, marker] of [3, 8].entries()) {
      expect(inputOf().evidence.find((item) => item.marker === marker)?.guidelineTitle).toBe(evidence[index].title);
    }
  });

  it('기준 9-path: 구조화 근거에 각 청크의 절 경로를 싣는다', async () => {
    await finish(await pinnedTurn());
    expect(evidence[0].path).not.toEqual(evidence[1].path);
    expect(inputOf().evidence).toHaveLength(2);
    for (const [index, marker] of [3, 8].entries()) {
      expect(inputOf().evidence.find((item) => item.marker === marker)?.sectionPath).toEqual(evidence[index].path);
    }
  });

  it('기준 10: 구조화 프로필은 고정 기록의 값 있는 필드만 포함한다', async () => {
    const turn = await pinnedTurn();
    // 고정 뒤 원본 변경: 최신 환자 행을 다시 읽는 구현도 구별한다.
    const current = await request(app.getHttpServer()).get(`/api/v1/patients/${turn.patientId}`)
      .set('Cookie', owner.cookie).expect(200);
    await request(app.getHttpServer()).patch(`/api/v1/patients/${turn.patientId}`)
      .set(CSRF).set('Cookie', owner.cookie)
      .send({ version: dataOf<{ version: number }>(current).version, diagnoses: [`합성변경진단-${ulid()}`] })
      .expect(200);
    await finish(turn);
    expect(inputOf().profileFields).toEqual([
      { field: '진단명', value: turn.fields.diagnoses[0] },
      { field: '투약 목록', value: turn.fields.medications[0] },
      { field: '알레르기 이력', value: turn.fields.allergies[0] },
      { field: '임상 메모', value: turn.fields.clinicalNotes },
    ]);
    expect(inputOf().profileFields.map((item) => item.field)).not.toContain('허리둘레');
  });

  it('기준 11: 영어로 수락한 턴은 구조화 언어도 en이다', async () => {
    await finish(await pinnedTurn(owner, 'en'));
    expect(inputOf().lang).toBe('en');
  });

  it('기준 12: 검증된 구조화 항목의 composer_version은 구조화 프롬프트 버전이다', async () => {
    const turn = await pinnedTurn();
    const data = await finish(turn);
    expect(structurer.calls).toBe(1);
    expect(inputOf().lang).toBe('ko');
    expect(guidanceOf(data).considerations).toHaveLength(2);
    expect((await oneGuidance(turn)).composer_version).toBe('guidance-v2');
  });

  it('기준 13: 구조화 성공에도 스냅샷의 합성 알레르기 안전 경고가 남는다', async () => {
    const turn = await pinnedTurn();
    const guidance = guidanceOf(await finish(turn));
    expect((await oneGuidance(turn)).composer_version).toBe('guidance-v2');
    expect(guidance.safetyAlerts.some((alert) => alert.description.includes(turn.fields.allergies[0]))).toBe(true);
  });

  it('기준 14: 참고안을 만든 완결의 answerKind는 CLINICAL_GUIDANCE다', async () => {
    expect((await finish(await pinnedTurn())).answerKind).toBe('CLINICAL_GUIDANCE');
  });

  it('기준 15: 메시지 재조회에 저장된 참고안의 guidanceId가 실린다', async () => {
    const turn = await pinnedTurn();
    await finish(turn);
    const row = await oneGuidance(turn);
    const response = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${turn.conversationId}/messages`).set('Cookie', owner.cookie).expect(200);
    const messages = dataOf<MessageResponseDto[]>(response);
    expect(messages.find((item) => item.id === turn.assistantMessageId)).toMatchObject({
      role: 'ASSISTANT', guidanceId: row.id,
    });
  });

  it('기준 16: 참고안 상세 API가 복합 참고안을 돌려준다', async () => {
    const turn = await pinnedTurn();
    const guidance = guidanceOf(await finish(turn));
    const row = await oneGuidance(turn);
    expect(guidance.id).toBe(row.id);
    const response = await request(app.getHttpServer()).get(`/api/v1/clinical-guidance/${row.id}`)
      .set('Cookie', owner.cookie).expect(200);
    expect(dataOf(response)).toEqual(guidance);
  });

  it('기준 17: 복합 참고안 검토가 응답 상태와 감사 행에 기록된다', async () => {
    const { row } = await rowControl();
    await review(row.id);
  });

  it('기준 18: 구조화기가 실제 예외를 던져도 완결은 200이다', async () => {
    structurer.mode = 'throw';
    const before = structurer.calls;
    await finish(await pinnedTurn());
    expect(structurer.calls).toBe(before + 1);
  });

  it('기준 19: 구조화 예외는 deterministic-v1 참고안으로 폴백한다', async () => {
    structurer.mode = 'throw';
    const turn = await pinnedTurn();
    await finish(turn);
    expect(structurer.calls).toBe(1);
    expect((await oneGuidance(turn)).composer_version).toBe('deterministic-v1');
  });

  it('기준 20: 인용에 없는 마커로 전멸한 구조화는 결정적 폴백이다', async () => {
    structurer.mode = 'invalid';
    const turn = await pinnedTurn();
    await finish(turn);
    expect(structurer.calls).toBe(1);
    expect(inputOf().evidence.map((item) => item.marker)).not.toContain(999999);
    expect((await oneGuidance(turn)).composer_version).toBe('deterministic-v1');
  });

  it('기준 21: disabled 킬스위치에서는 구조화기를 부르지 않는다', async () => {
    await callControl();
    structurer.mode = 'disabled';
    const before = structurer.calls;
    await finish(await pinnedTurn());
    expect(structurer.calls).toBe(before);
  });

  it('기준 22: disabled여도 deterministic-v1 참고안 한 행이 생긴다', async () => {
    structurer.mode = 'disabled';
    const turn = await pinnedTurn();
    await finish(turn);
    expect((await oneGuidance(turn)).composer_version).toBe('deterministic-v1');
  });

  it('기준 23: 인용 없는 복합 완료는 구조화기를 부르지 않는다', async () => {
    await callControl();
    const before = structurer.calls;
    await finish(await pinnedTurn(), { ...compositeBody(), content: '인용 없는 합성 검토 답변.', citations: [] });
    expect(structurer.calls).toBe(before);
  });

  it('기준 24: 인용 없는 복합 참고안도 검토 항목 한 건을 갖는다', async () => {
    const data = await finish(await pinnedTurn(), {
      ...compositeBody(), content: '인용 없는 합성 검토 답변.', citations: [],
    });
    expect(guidanceOf(data).considerations).toHaveLength(1);
  });

  it('기준 25: 닫힌 턴의 복합 완결은 구조화 전에 409다', async () => {
    await callControl();
    const turn = await pinnedTurn();
    await finish(turn, { status: 'CANCELLED', route: 'COMPOSITE' });
    const before = structurer.calls;
    expectError(await finishRequest(turn), 409, 'AGENT_TURN_CLOSED');
    expect(structurer.calls).toBe(before);
  });

  function missingEvidenceBody(): FinishAgentTurnRequestDto {
    return { ...compositeBody(), citations: [{ marker: 3, evidenceId: `missing-${ulid()}` }] };
  }

  it('기준 26: 없는 근거의 422는 구조화 호출보다 먼저다', async () => {
    await callControl();
    const before = structurer.calls;
    expectError(await finishRequest(await pinnedTurn(), missingEvidenceBody()), 422, 'VALIDATION_FAILED');
    expect(structurer.calls).toBe(before);
  });

  it('기준 27: 없는 근거를 인용한 메시지는 참고안을 저장하지 않는다', async () => {
    await rowControl();
    const turn = await pinnedTurn();
    expectError(await finishRequest(turn, missingEvidenceBody()), 422, 'VALIDATION_FAILED');
    expect(await guidanceRows(turn)).toHaveLength(0);
  });

  async function cancellationRace() {
    const turn = await pinnedTurn();
    const block = { entered: latch(), release: latch() };
    structurer.block = block;
    structurer.mode = 'blocked';
    // then()으로 supertest의 지연 요청을 실제 시작한다. 타임아웃은 교착 방지용이며 소요 시간 단언이 아니다.
    const pending = finishRequest(turn).timeout({ deadline: 15_000 }).then((response) => response);
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
      const cancelled = await finishRequest(turn, { status: 'CANCELLED', route: 'COMPOSITE' })
        .timeout({ deadline: 10_000 }).expect(200);
      expect(dataOf<AgentTurnFinishResponseDto>(cancelled).status).toBe('CANCELLED');
      block.release.resolve();
      const losing = await pending;
      expectError(losing, 409, 'AGENT_TURN_CLOSED');
      expect((await pool.query('SELECT status, content FROM messages WHERE id = $1',
        [turn.assistantMessageId])).rows).toEqual([{ status: 'CANCELLED', content: '' }]);
      return turn;
    } finally {
      clearTimeout(timer);
      block.release.resolve();
      await pending.catch(() => undefined);
      structurer.mode = 'valid';
      structurer.block = undefined;
    }
  }

  it('기준 28: 구조화 중 CANCELLED가 이기면 앞선 복합 완결은 409다', async () => {
    await cancellationRace();
  });

  it('기준 29-guidance: 취소에 진 복합 완결은 참고안을 남기지 않는다', async () => {
    await rowControl();
    const turn = await cancellationRace();
    expect(await guidanceRows(turn)).toHaveLength(0);
  });

  it('기준 29-citations: 취소에 진 복합 완결은 인용을 남기지 않는다', async () => {
    const control = await rowControl();
    expect((await pool.query('SELECT id FROM message_citations WHERE message_id = $1',
      [control.turn.assistantMessageId])).rows).toHaveLength(2);
    const turn = await cancellationRace();
    expect((await pool.query('SELECT id FROM message_citations WHERE message_id = $1',
      [turn.assistantMessageId])).rows).toHaveLength(0);
  });

  it('기준 30: 스냅샷 없는 복합 완료는 200이며 guidance 키가 없다', async () => {
    guidanceOf(await finish(await pinnedTurn()));
    const data = await finish(await freshTurn());
    expect('guidance' in data).toBe(false);
  });

  it('기준 31: 스냅샷 없는 복합 완료에는 answerKind 키가 없다', async () => {
    expect((await finish(await pinnedTurn())).answerKind).toBe('CLINICAL_GUIDANCE');
    const data = await finish(await freshTurn());
    expect('answerKind' in data).toBe(false);
  });

  function patientBody(): FinishAgentTurnRequestDto {
    return { status: 'COMPLETED', route: 'PATIENT', content: '합성 환자 기록 조회 답변.' };
  }

  it('기준 32: 스냅샷이 있어도 PATIENT 완료에는 guidance 키가 없다', async () => {
    guidanceOf(await finish(await pinnedTurn()));
    const data = await finish(await pinnedTurn(), patientBody());
    expect('guidance' in data).toBe(false);
  });

  it('기준 33: PATIENT 완료는 구조화기를 부르지 않는다', async () => {
    await callControl();
    const before = structurer.calls;
    await finish(await pinnedTurn(), patientBody());
    expect(structurer.calls).toBe(before);
  });

  it('기준 34: 복합 기권에는 참고안 행과 guidance 키가 없다', async () => {
    const control = await rowControl();
    guidanceOf(control.data);
    const turn = await pinnedTurn();
    const data = await finish(turn, {
      status: 'ABSTAINED', route: 'COMPOSITE', abstainReason: 'insufficient_evidence',
    });
    expect(await guidanceRows(turn)).toHaveLength(0);
    expect('guidance' in data).toBe(false);
  });

  it('기준 35-failed: 복합 FAILED 완결은 구조화기를 부르지 않는다', async () => {
    await callControl();
    const before = structurer.calls;
    await finish(await pinnedTurn(), { status: 'FAILED', route: 'COMPOSITE' });
    expect(structurer.calls).toBe(before);
  });

  it('기준 35-cancelled: 복합 CANCELLED 완결은 구조화기를 부르지 않는다', async () => {
    await callControl();
    const before = structurer.calls;
    await finish(await pinnedTurn(), { status: 'CANCELLED', route: 'COMPOSITE' });
    expect(structurer.calls).toBe(before);
  });

  async function expectPurged(turn: Awaited<ReturnType<typeof pinnedTurn>>, guidanceId: string) {
    // 부모 JOIN 없이 각 자식의 고정 id/외래키로 검사해 고아 행을 숨기지 않는다.
    const queries: [string, string][] = [
      ['SELECT id FROM guidance_reviews WHERE guidance_id = $1', guidanceId],
      ['SELECT id FROM clinical_guidances WHERE message_id = $1', turn.assistantMessageId],
      ['SELECT id FROM message_citations WHERE message_id = $1', turn.assistantMessageId],
      ['SELECT id FROM generation_runs WHERE message_id = $1', turn.assistantMessageId],
      ['SELECT message_id FROM agent_turns WHERE message_id = $1', turn.assistantMessageId],
      ['SELECT id FROM messages WHERE conversation_id = $1', turn.conversationId],
      ['SELECT id FROM conversations WHERE id = $1', turn.conversationId],
      ['SELECT id FROM patient_profile_snapshots WHERE patient_id = $1', turn.patientId],
      ['SELECT id FROM patients WHERE id = $1', turn.patientId],
    ];
    for (const [sql, id] of queries) expect((await pool.query(sql, [id])).rows).toHaveLength(0);
  }

  it('기준 37: 검토된 복합 참고안의 환자 삭제 유예 뒤 전체 참조 체인이 파기된다', async () => {
    const { turn, row } = await rowControl();
    await review(row.id);
    const deleted = await request(app.getHttpServer()).delete(`/api/v1/patients/${turn.patientId}`)
      .set(CSRF).set('Cookie', owner.cookie).expect(200);
    dataOf(deleted);
    for (const [table, id] of [['patients', turn.patientId], ['conversations', turn.conversationId]]) {
      const reserved = (await pool.query<{ deleted_at: Date | null }>(
        `SELECT deleted_at FROM ${table} WHERE id = $1`, [id],
      )).rows;
      expect(reserved).toHaveLength(1);
      expect(reserved[0].deleted_at).not.toBeNull();
      expect((await pool.query(
        `UPDATE ${table} SET deleted_at = now() - interval '400 days' WHERE id = $1`, [id],
      )).rowCount).toBe(1);
    }
    // 대화가 남은 환자를 보류하는 기존 정책도 허용한다. 두 틱 모두 오류 없이 끝나야 한다.
    await expect(app.get(DataPurgeService).purge()).resolves.toMatchObject({ skipped: false });
    await expect(app.get(DataPurgeService).purge()).resolves.toMatchObject({ skipped: false });
    await expectPurged(turn, row.id);
  });

  it('기준 38: 별도 클리닉 파기는 복합 참고안 체인을 지우고 다른 클리닉을 보존한다', async () => {
    const survivor = await rowControl();
    const suffix = ulid();
    const session = await socialSignUp(app, {
      email: `spec54-purge-${suffix}@clinic.kr`, providerId: `spec54-purge-${suffix}`,
      clinicName: '합성 파기 전용 클리닉', licenseNumber: `spec54-${suffix}`,
    });
    expect(session.clinicId).not.toBe(owner.clinicId);
    const turn = await pinnedTurn(session);
    guidanceOf(await finish(turn));
    const row = await oneGuidance(turn);
    await review(row.id, session);
    expect((await pool.query(
      "UPDATE clinics SET deleted_at = now() - interval '400 days' WHERE id = $1", [session.clinicId],
    )).rowCount).toBe(1);
    await expect(app.get(DataPurgeService).purge()).resolves.toMatchObject({ skipped: false });
    await expectPurged(turn, row.id);
    for (const table of ['conversations', 'patients', 'patient_profile_snapshots', 'clinical_guidances']) {
      expect((await pool.query(`SELECT id FROM ${table} WHERE clinic_id = $1`, [session.clinicId])).rows).toHaveLength(0);
    }
    expect((await pool.query('SELECT id FROM clinics WHERE id = $1', [session.clinicId])).rows).toHaveLength(0);
    expect((await pool.query('SELECT id FROM clinics WHERE id = $1', [owner.clinicId])).rows).toHaveLength(1);
    expect((await pool.query('SELECT id FROM conversations WHERE id = $1', [survivor.turn.conversationId])).rows).toHaveLength(1);
    expect((await pool.query('SELECT id FROM patients WHERE id = $1', [survivor.turn.patientId])).rows).toHaveLength(1);
    expect((await pool.query('SELECT id FROM patient_profile_snapshots WHERE id = $1', [survivor.turn.snapshotId])).rows).toHaveLength(1);
    expect((await oneGuidance(survivor.turn)).id).toBe(survivor.row.id);
  });
});
