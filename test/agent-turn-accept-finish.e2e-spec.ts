// docs/specs/51 수용 기준 68~87·106~116 동결 테스트 — 구현 중 수정 금지
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
import { MessageResponseDto } from '../src/domain/conversation/dto/response/message.response.dto';
import { AGENT_ABSTAIN_REASON_MESSAGE } from '../src/domain/conversation/mapper/conversation.mapper';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { yotongGuideline } from './fixtures/guideline-samples';
import { socialSignUp, type TestSession } from './fixtures/social-auth';
import { parseSseEvents, type SseEvent } from './fixtures/sse';

const CSRF = { 'X-CSRF-Protection': '1' };
const QUESTION = '만성 요통에 침 치료를 권고하나요?';
const ANSWER = '합성 환자 기록에 기재된 사항을 정리한 답변입니다.';

interface AcceptedTurn {
  userMessageId: string;
  assistantMessageId: string;
}

interface TurnRow {
  user_message_id: string;
  route: string | null;
  classifier_version: string | null;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('JSON 객체가 필요합니다.');
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  expect(value).toEqual(expect.any(String));
  if (typeof value !== 'string') throw new Error('문자열이 필요합니다.');
  return value;
}

function successData(response: SupertestResponse): unknown {
  const body = record(response.body as unknown);
  expect(body.success).toBe(true);
  return body.data;
}

function expectError(response: SupertestResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
  const body = record(response.body as unknown);
  expect(body.success).toBe(false);
  expect(body.code).toBe(code);
}

function completedEvents(response: SupertestResponse): SseEvent[] {
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toContain('text/event-stream');
  const events = parseSseEvents(response.text);
  const terminal = events.filter((event) =>
    ['answer.completed', 'answer.abstained', 'error'].includes(event.eventType),
  );
  expect(terminal[terminal.length - 1]?.eventType).toBe('answer.completed');
  return events;
}

function patientFinish(): FinishAgentTurnRequestDto {
  return {
    status: 'COMPLETED',
    route: 'PATIENT',
    content: ANSWER,
    generation: {
      provider: 'spec51-agent-provider',
      model: 'spec51-agent-model',
      promptVersion: 'spec51-agent-prompt-v1',
      latencyMs: 1200,
      inputTokens: 80,
      outputTokens: 30,
    },
  };
}

describe('docs/specs/51: BE 수락·지침 도구·완결', () => {
  jest.setTimeout(180_000);

  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let owner: TestSession;
  let otherClinic: TestSession;

  beforeAll(async () => {
    [postgresContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = postgresContainer.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();
    pool = new Pool({ connectionString: postgresContainer.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);
    await app.get(GuidelineIngestService).ingest(yotongGuideline);
    owner = await socialSignUp(app, {
      email: 'spec51a-owner@clinic.kr',
      providerId: 'spec51a-owner',
      displayName: '수락완결 소유 의료인',
      clinicName: 'spec51a-owner-clinic',
      licenseNumber: 'spec51a-owner-license',
    });
    otherClinic = await socialSignUp(app, {
      email: 'spec51a-other@clinic.kr',
      providerId: 'spec51a-other',
      displayName: '수락완결 타 의료인',
      clinicName: 'spec51a-other-clinic',
      licenseNumber: 'spec51a-other-license',
    });
    expect(owner.clinicId).not.toBe(otherClinic.clinicId);
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      try {
        await pool?.end();
      } finally {
        await Promise.all([postgresContainer?.stop(), redisContainer?.stop()]);
      }
    }
  });

  const post = (path: string, session: TestSession = owner) =>
    request(app.getHttpServer()).post(path).set(CSRF).set('Cookie', session.cookie);

  const createConversation = async (
    session: TestSession = owner,
    patientId?: string,
  ): Promise<string> => {
    const response = await post('/api/v1/conversations', session)
      .send(
        patientId
          ? { type: 'PATIENT_GUIDANCE', patientId }
          : { type: 'GUIDELINE_QA' },
      )
      .expect(201);
    return stringValue(record(successData(response)).id);
  };

  const accept = async (
    conversationId: string,
    options: { content?: string; clientRequestId?: string; responseLang?: 'ko' | 'en' } = {},
  ): Promise<AcceptedTurn> => {
    const response = await post(
      `/api/v1/internal/agent/conversations/${conversationId}/turns`,
    )
      .send({ content: QUESTION, clientRequestId: randomUUID(), ...options })
      .expect(201);
    const data = record(successData(response));
    return {
      userMessageId: stringValue(data.userMessageId),
      assistantMessageId: stringValue(data.assistantMessageId),
    };
  };

  const freshTurn = async () => {
    const conversationId = await createConversation();
    return { conversationId, ...(await accept(conversationId)) };
  };

  const messages = async (conversationId: string): Promise<MessageResponseDto[]> => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set('Cookie', owner.cookie)
      .expect(200);
    const data = successData(response);
    expect(Array.isArray(data)).toBe(true);
    if (!Array.isArray(data)) throw new Error('메시지 목록이 필요합니다.');
    return data as MessageResponseDto[];
  };

  const message = async (conversationId: string, messageId: string) => {
    const found = (await messages(conversationId)).find((item) => item.id === messageId);
    expect(found).toBeDefined();
    if (!found) throw new Error('수락된 메시지가 목록에 없습니다.');
    return found;
  };

  const title = async (conversationId: string): Promise<string> => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}`)
      .set('Cookie', owner.cookie)
      .expect(200);
    return stringValue(record(successData(response)).title);
  };

  const turnRow = async (assistantMessageId: string): Promise<TurnRow> => {
    const result = await pool.query<TurnRow>(
      `SELECT user_message_id, route, classifier_version
         FROM agent_turns WHERE message_id = $1`,
      [assistantMessageId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  };

  const guideline = async (
    assistantMessageId: string,
    classifierVersion = `spec51-classifier-${ulid()}`,
  ): Promise<SseEvent[]> => {
    const response = await post(
      `/api/v1/internal/agent/turns/${assistantMessageId}/guideline-answer`,
    )
      .send({ classifierVersion })
      .expect(200);
    return completedEvents(response);
  };

  const finish = async (
    assistantMessageId: string,
    body: FinishAgentTurnRequestDto = patientFinish(),
  ): Promise<Record<string, unknown>> => {
    const response = await post(`/api/v1/internal/agent/turns/${assistantMessageId}/finish`)
      .send(body)
      .expect(200);
    return record(successData(response));
  };

  const runs = async (assistantMessageId: string) => {
    const result = await pool.query<{ retrieval_policy_version: string | null }>(
      'SELECT retrieval_policy_version FROM generation_runs WHERE message_id = $1',
      [assistantMessageId],
    );
    return result.rows;
  };

  it('기준 68: 수락의 두 id는 새 USER·ASSISTANT 메시지의 id다', async () => {
    const conversationId = await createConversation();
    expect(await messages(conversationId)).toEqual([]);
    const accepted = await accept(conversationId);
    const saved = await messages(conversationId);
    expect(saved.map(({ id }) => id).sort()).toEqual(
      [accepted.userMessageId, accepted.assistantMessageId].sort(),
    );
    expect(saved.find(({ id }) => id === accepted.userMessageId)?.role).toBe('USER');
    expect(saved.find(({ id }) => id === accepted.assistantMessageId)?.role).toBe('ASSISTANT');
  });

  it('기준 69: USER는 요청 content와 COMPLETED 상태로 저장된다', async () => {
    const conversationId = await createConversation();
    const content = '합성 기록에 표시된 알레르기 항목을 알려 주세요.';
    const accepted = await accept(conversationId, { content });
    expect(await message(conversationId, accepted.userMessageId)).toMatchObject({
      content,
      status: 'COMPLETED',
    });
  });

  it('기준 70: ASSISTANT는 빈 content와 STREAMING 상태로 저장된다', async () => {
    const turn = await freshTurn();
    expect(await message(turn.conversationId, turn.assistantMessageId)).toMatchObject({
      content: '',
      status: 'STREAMING',
    });
  });

  it('기준 71: 수락된 ASSISTANT DTO에는 answerKind 키가 없다', async () => {
    const turn = await freshTurn();
    const saved = await message(turn.conversationId, turn.assistantMessageId);
    expect('answerKind' in saved).toBe(false);
  });

  it('기준 72-en: en 명시 수락은 두 메시지에 en을 저장한다', async () => {
    const conversationId = await createConversation();
    const accepted = await accept(conversationId, { responseLang: 'en' });
    expect((await message(conversationId, accepted.userMessageId)).responseLang).toBe('en');
    expect((await message(conversationId, accepted.assistantMessageId)).responseLang).toBe('en');
  });

  it('기준 72-ko: 언어 미지정 수락은 두 메시지에 ko를 저장한다', async () => {
    const turn = await freshTurn();
    expect((await message(turn.conversationId, turn.userMessageId)).responseLang).toBe('ko');
    expect((await message(turn.conversationId, turn.assistantMessageId)).responseLang).toBe('ko');
  });

  it('기준 73: 수락은 USER를 연결하고 route가 NULL인 턴 한 행을 만든다', async () => {
    const turn = await freshTurn();
    expect(await turnRow(turn.assistantMessageId)).toMatchObject({
      user_message_id: turn.userMessageId,
      route: null,
    });
  });

  it('기준 74: 같은 clientRequestId의 재수락은 409 DUPLICATE_CLIENT_REQUEST다', async () => {
    const conversationId = await createConversation();
    const clientRequestId = randomUUID();
    await accept(conversationId, { clientRequestId });
    const response = await post(`/api/v1/internal/agent/conversations/${conversationId}/turns`)
      .send({ content: QUESTION, clientRequestId });
    expectError(response, 409, 'DUPLICATE_CLIENT_REQUEST');
  });

  it('기준 75: 타 클리닉 대화의 수락은 404 NOT_FOUND다', async () => {
    const conversationId = await createConversation(otherClinic);
    const response = await post(`/api/v1/internal/agent/conversations/${conversationId}/turns`)
      .send({ content: QUESTION, clientRequestId: randomUUID() });
    expectError(response, 404, 'NOT_FOUND');
  });

  it('기준 76: PATIENT_GUIDANCE 대화의 수락은 400 BAD_REQUEST다', async () => {
    const patient = await post('/api/v1/patients')
      .send({
        caseLabel: `spec51a-${ulid()}`,
        diagnoses: ['합성 진단'],
        medications: [],
        allergies: [],
      })
      .expect(201);
    const patientId = stringValue(record(successData(patient)).id);
    const conversationId = await createConversation(owner, patientId);
    const response = await post(`/api/v1/internal/agent/conversations/${conversationId}/turns`)
      .send({ content: QUESTION, clientRequestId: randomUUID() });
    expectError(response, 400, 'BAD_REQUEST');
  });

  it('기준 77: 수락은 기본 대화 제목을 바꾸지 않는다', async () => {
    const conversationId = await createConversation();
    const before = await title(conversationId);
    expect(before).toBe('새 대화');
    await accept(conversationId);
    expect(await title(conversationId)).toBe(before);
  });

  it('기준 78: 완료된 지침 스트림에는 message.accepted가 없다', async () => {
    const turn = await freshTurn();
    const events = await guideline(turn.assistantMessageId);
    expect(events.some((event) => event.eventType === 'message.accepted')).toBe(false);
  });

  it('기준 79: 지침 완료는 수락된 ASSISTANT에 COMPLETED와 답변을 저장한다', async () => {
    const turn = await freshTurn();
    await guideline(turn.assistantMessageId);
    const saved = await message(turn.conversationId, turn.assistantMessageId);
    expect(saved.status).toBe('COMPLETED');
    expect(typeof saved.content).toBe('string');
    expect(saved.content.trim().length).toBeGreaterThan(0);
  });

  it('기준 80: 지침 완료 메시지의 answerKind는 GUIDELINE_ANSWER다', async () => {
    const turn = await freshTurn();
    await guideline(turn.assistantMessageId);
    expect((await message(turn.conversationId, turn.assistantMessageId)).answerKind).toBe(
      'GUIDELINE_ANSWER',
    );
  });

  it('기준 81: 지침 완료는 수락 직후의 두 메시지와 id 집합을 유지한다', async () => {
    const turn = await freshTurn();
    const before = await messages(turn.conversationId);
    expect(before).toHaveLength(2);
    const expectedIds = [turn.userMessageId, turn.assistantMessageId].sort();
    expect(before.map(({ id }) => id).sort()).toEqual(expectedIds);
    await guideline(turn.assistantMessageId);
    const after = await messages(turn.conversationId);
    expect(after).toHaveLength(before.length);
    expect(after.map(({ id }) => id).sort()).toEqual(expectedIds);
  });

  it('기준 82-citations: 지침 인용은 수락된 메시지에 저장된다', async () => {
    const turn = await freshTurn();
    await guideline(turn.assistantMessageId);
    const result = await pool.query<{ id: string }>(
      'SELECT id FROM message_citations WHERE message_id = $1',
      [turn.assistantMessageId],
    );
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('기준 82-run: 지침 생성 이력은 수락된 메시지에 한 행 저장된다', async () => {
    const turn = await freshTurn();
    await guideline(turn.assistantMessageId);
    expect(await runs(turn.assistantMessageId)).toHaveLength(1);
  });

  it('기준 83: 지침 완료 턴의 route는 GUIDELINE이다', async () => {
    const turn = await freshTurn();
    await guideline(turn.assistantMessageId);
    expect((await turnRow(turn.assistantMessageId)).route).toBe('GUIDELINE');
  });

  it('기준 84: 지침 도구의 classifierVersion이 턴에 저장된다', async () => {
    const turn = await freshTurn();
    const classifierVersion = `spec51-classifier-${ulid()}`;
    await guideline(turn.assistantMessageId, classifierVersion);
    expect((await turnRow(turn.assistantMessageId)).classifier_version).toBe(classifierVersion);
  });

  it('기준 85: 지침 완료는 기본 제목을 질문으로 바꾸고 AUTO로 기록한다', async () => {
    const turn = await freshTurn();
    expect(await title(turn.conversationId)).toBe('새 대화');
    const before = await pool.query<{ title_source: string }>(
      'SELECT title_source FROM conversations WHERE id = $1',
      [turn.conversationId],
    );
    expect(before.rows).toEqual([{ title_source: 'DEFAULT' }]);
    await guideline(turn.assistantMessageId);
    expect(await title(turn.conversationId)).toBe(QUESTION);
    const after = await pool.query<{ title_source: string }>(
      'SELECT title_source FROM conversations WHERE id = $1',
      [turn.conversationId],
    );
    expect(after.rows).toEqual([{ title_source: 'AUTO' }]);
  });

  it('기준 86: 채팅이 만든 ASSISTANT의 지침 도구 호출은 404 NOT_FOUND다', async () => {
    const conversationId = await createConversation();
    const chat = await post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .send({ content: QUESTION, clientRequestId: randomUUID() })
      .expect(200);
    const events = completedEvents(chat);
    const accepted = events.find((event) => event.eventType === 'message.accepted');
    expect(accepted).toBeDefined();
    const assistantMessageId = stringValue(accepted?.assistantMessageId);
    const response = await post(
      `/api/v1/internal/agent/turns/${assistantMessageId}/guideline-answer`,
    ).send({ classifierVersion: `spec51-classifier-${ulid()}` });
    expectError(response, 404, 'NOT_FOUND');
  });

  it('기준 87: 지침으로 닫힌 턴의 재호출은 409 AGENT_TURN_CLOSED다', async () => {
    const turn = await freshTurn();
    await guideline(turn.assistantMessageId);
    const response = await post(
      `/api/v1/internal/agent/turns/${turn.assistantMessageId}/guideline-answer`,
    ).send({ classifierVersion: `spec51-classifier-${ulid()}` });
    expectError(response, 409, 'AGENT_TURN_CLOSED');
  });

  it('기준 106: PATIENT 완결은 COMPLETED와 요청 content를 저장한다', async () => {
    const turn = await freshTurn();
    await finish(turn.assistantMessageId);
    expect(await message(turn.conversationId, turn.assistantMessageId)).toMatchObject({
      status: 'COMPLETED',
      content: ANSWER,
    });
  });

  it('기준 107: PATIENT 완결은 턴의 route를 PATIENT로 저장한다', async () => {
    const turn = await freshTurn();
    await finish(turn.assistantMessageId);
    expect((await turnRow(turn.assistantMessageId)).route).toBe('PATIENT');
  });

  it('기준 108: PATIENT 생성 이력 한 행의 검색 정책 버전은 NULL이다', async () => {
    const turn = await freshTurn();
    await finish(turn.assistantMessageId);
    expect(await runs(turn.assistantMessageId)).toEqual([{ retrieval_policy_version: null }]);
  });

  it('기준 109: 완결의 classifierVersion은 턴의 NULL 분류기 버전을 채운다', async () => {
    const turn = await freshTurn();
    expect((await turnRow(turn.assistantMessageId)).classifier_version).toBeNull();
    const classifierVersion = `spec51-classifier-${ulid()}`;
    await finish(turn.assistantMessageId, { ...patientFinish(), classifierVersion });
    expect((await turnRow(turn.assistantMessageId)).classifier_version).toBe(classifierVersion);
  });

  it('기준 110: COMPOSITE 완결 인용의 마커와 근거 id가 재조회된다', async () => {
    const turn = await freshTurn();
    const evidence = await pool.query<{ id: string }>('SELECT id FROM evidence_chunks ORDER BY id');
    expect(evidence.rows.length).toBeGreaterThanOrEqual(2);
    const citations = [
      { marker: 1, evidenceId: evidence.rows[0].id },
      { marker: 2, evidenceId: evidence.rows[1].id },
    ];
    expect(citations[0].evidenceId).not.toBe(citations[1].evidenceId);
    await finish(turn.assistantMessageId, {
      ...patientFinish(),
      route: 'COMPOSITE',
      content: '합성 기록과 첫 근거의 요약 [1]. 두 번째 근거의 요약 [2].',
      citations,
    });
    const saved = await message(turn.conversationId, turn.assistantMessageId);
    expect(
      saved.citations
        .map(({ marker, evidenceId }) => ({ marker, evidenceId }))
        .sort((left, right) => left.marker - right.marker),
    ).toEqual(citations);
  });

  it('기준 111: 존재하지 않는 근거 인용은 422 VALIDATION_FAILED다', async () => {
    const turn = await freshTurn();
    const evidenceId = `spec51-missing-evidence-${ulid()}`;
    const response = await post(
      `/api/v1/internal/agent/turns/${turn.assistantMessageId}/finish`,
    ).send({
      ...patientFinish(),
      route: 'COMPOSITE',
      content: '존재하지 않는 합성 근거의 인용 [1].',
      citations: [{ marker: 1, evidenceId }],
    });
    expectError(response, 422, 'VALIDATION_FAILED');
  });

  it('기준 112-out_of_scope: 범위 밖 기권은 한국어 사유 문장으로 재조회된다', async () => {
    const turn = await freshTurn();
    await finish(turn.assistantMessageId, {
      status: 'ABSTAINED',
      route: 'OTHER',
      abstainReason: 'out_of_scope',
    });
    const saved = await message(turn.conversationId, turn.assistantMessageId);
    expect(saved.status).toBe('ABSTAINED');
    expect(saved.abstainReason).toBe(AGENT_ABSTAIN_REASON_MESSAGE.ko.out_of_scope);
    expect(saved.abstainReason).not.toBe('out_of_scope');
  });

  it('기준 112-patient_unresolved: 환자 미특정 기권은 한국어 사유 문장으로 재조회된다', async () => {
    const turn = await freshTurn();
    await finish(turn.assistantMessageId, {
      status: 'ABSTAINED',
      route: 'PATIENT',
      abstainReason: 'patient_unresolved',
    });
    const saved = await message(turn.conversationId, turn.assistantMessageId);
    expect(saved.status).toBe('ABSTAINED');
    expect(saved.abstainReason).toBe(AGENT_ABSTAIN_REASON_MESSAGE.ko.patient_unresolved);
    expect(saved.abstainReason).not.toBe('patient_unresolved');
  });

  it('기준 113: COMPOSITE 생성 기권의 generation은 이력 한 행으로 남는다', async () => {
    const turn = await freshTurn();
    const generation = patientFinish().generation;
    if (!generation) throw new Error('합성 생성 정보가 필요합니다.');
    await finish(turn.assistantMessageId, {
      status: 'ABSTAINED',
      route: 'COMPOSITE',
      abstainReason: 'insufficient_evidence',
      generation: {
        ...generation,
        retrievalPolicyVersion: 'spec51-retrieval-policy-v1',
        searchQuestion: QUESTION,
      },
    });
    expect(await runs(turn.assistantMessageId)).toHaveLength(1);
  });

  it('기준 114: 이미 완결된 턴의 재완결은 409 AGENT_TURN_CLOSED다', async () => {
    const turn = await freshTurn();
    await finish(turn.assistantMessageId);
    const response = await post(
      `/api/v1/internal/agent/turns/${turn.assistantMessageId}/finish`,
    ).send(patientFinish());
    expectError(response, 409, 'AGENT_TURN_CLOSED');
  });

  it('기준 115: 재완결 409 뒤에도 최초 상태와 content가 보존된다', async () => {
    const turn = await freshTurn();
    await finish(turn.assistantMessageId);
    const before = await message(turn.conversationId, turn.assistantMessageId);
    expect(before).toMatchObject({ status: 'COMPLETED', content: ANSWER });
    const response = await post(
      `/api/v1/internal/agent/turns/${turn.assistantMessageId}/finish`,
    ).send({ status: 'FAILED', route: 'PATIENT', content: '덮어쓰기를 시도하는 다른 합성 답변.' });
    expectError(response, 409, 'AGENT_TURN_CLOSED');
    const after = await message(turn.conversationId, turn.assistantMessageId);
    expect(after.status).toBe(before.status);
    expect(after.content).toBe(before.content);
  });

  it('기준 116: 완결 응답의 수락된 메시지에는 answerKind 키가 없다', async () => {
    const turn = await freshTurn();
    const data = await finish(turn.assistantMessageId);
    expect(data.id).toBe(turn.assistantMessageId);
    expect('answerKind' in data).toBe(false);
  });
});
