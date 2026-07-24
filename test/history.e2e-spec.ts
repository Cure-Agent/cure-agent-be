// docs/specs/11 수용 기준 1~5 동결 테스트 — 구현 중 수정 금지

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';

describe('Conversation history (e2e)', () => {
  let app: INestApplication;
  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let ownerCookie: string;
  let otherClinicianCookie: string;

  const csrfHeader = { 'X-CSRF-Protection': '1' };

  const signUp = async (
    email: string,
    clinicName: string,
    licenseNumber: string,
  ): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .set('X-CSRF-Protection', '1')
      .send({
        email,
        password: 'password-1234',
        displayName: '김의사',
        clinicName,
        licenseNumber,
        termsAccepted: true,
      })
      .expect(201);

    const setCookie = response.headers['set-cookie'];
    const cookies = Array.isArray(setCookie)
      ? setCookie
      : setCookie
        ? [setCookie]
        : [];
    const accessTokenCookie = cookies
      .filter((cookie: string) => cookie.startsWith('access_token='))
      .map((cookie: string) => cookie.split(';')[0])
      .join('; ');

    expect(accessTokenCookie).not.toBe('');
    return accessTokenCookie;
  };

  const createConversation = async (
    cookie: string,
    title: string,
  ): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set('Cookie', cookie)
      .set(csrfHeader)
      .send({
        type: 'GUIDELINE_QA',
        title,
      })
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      data: {
        id: expect.any(String),
      },
    });

    return response.body.data.id as string;
  };

  beforeAll(async () => {
    [postgresContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);

    process.env.DATABASE_URL = postgresContainer.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await migrate(drizzle(pool), {
      migrationsFolder: 'drizzle/migrations',
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();

    ownerCookie = await signUp(
      'history-owner@example.com',
      '히스토리 소유 의원',
      'LIC-0042',
    );
    otherClinicianCookie = await signUp(
      'history-other@example.com',
      '히스토리 타인 의원',
      'LIC-0043',
    );
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await Promise.all([
      postgresContainer.stop(),
      redisContainer.stop(),
    ]);
  });

  it('제목을 수정하고 재조회하며 빈 제목을 거부한다', async () => {
    const conversationId = await createConversation(
      ownerCookie,
      '요통 상담 기록',
    );

    const updateResponse = await request(app.getHttpServer())
      .patch(`/api/v1/conversations/${conversationId}`)
      .set('Cookie', ownerCookie)
      .set(csrfHeader)
      .send({ title: '수정된 제목' })
      .expect(200);

    expect(updateResponse.body).toMatchObject({
      success: true,
      data: {
        title: '수정된 제목',
      },
    });

    const detailResponse = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}`)
      .set('Cookie', ownerCookie)
      .expect(200);

    expect(detailResponse.body).toMatchObject({
      success: true,
      data: {
        id: conversationId,
        title: '수정된 제목',
      },
    });

    const invalidResponse = await request(app.getHttpServer())
      .patch(`/api/v1/conversations/${conversationId}`)
      .set('Cookie', ownerCookie)
      .set(csrfHeader)
      .send({ title: '' })
      .expect(422);

    expect(invalidResponse.body).toMatchObject({
      success: false,
      code: 'VALIDATION_FAILED',
    });
  });

  it('보관과 해제를 처리하고 ACTIVE 상태의 해제를 멱등 처리한다', async () => {
    const conversationId = await createConversation(
      ownerCookie,
      '보관 상태 전환 기록',
    );

    const archiveResponse = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/archive`)
      .set('Cookie', ownerCookie)
      .set(csrfHeader)
      .expect(200);

    expect(archiveResponse.body).toMatchObject({
      success: true,
      data: null,
    });

    const archivedDetailResponse = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}`)
      .set('Cookie', ownerCookie)
      .expect(200);

    expect(archivedDetailResponse.body).toMatchObject({
      success: true,
      data: {
        id: conversationId,
        status: 'ARCHIVED',
      },
    });

    const unarchiveResponse = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/unarchive`)
      .set('Cookie', ownerCookie)
      .set(csrfHeader)
      .expect(200);

    expect(unarchiveResponse.body).toMatchObject({
      success: true,
      data: null,
    });

    const activeDetailResponse = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}`)
      .set('Cookie', ownerCookie)
      .expect(200);

    expect(activeDetailResponse.body).toMatchObject({
      success: true,
      data: {
        id: conversationId,
        status: 'ACTIVE',
      },
    });

    const idempotentUnarchiveResponse = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/unarchive`)
      .set('Cookie', ownerCookie)
      .set(csrfHeader)
      .expect(200);

    expect(idempotentUnarchiveResponse.body).toMatchObject({
      success: true,
      data: null,
    });

    const idempotentDetailResponse = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}`)
      .set('Cookie', ownerCookie)
      .expect(200);

    expect(idempotentDetailResponse.body).toMatchObject({
      success: true,
      data: {
        id: conversationId,
        status: 'ACTIVE',
      },
    });
  });

  it('상태 필터로 보관 대화와 활성 대화를 구분한다', async () => {
    const archivedConversationId = await createConversation(
      ownerCookie,
      '상태 필터 보관 대상',
    );
    const activeConversationId = await createConversation(
      ownerCookie,
      '상태 필터 활성 대상',
    );

    const beforeArchiveResponse = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .set('Cookie', ownerCookie)
      .expect(200);

    expect(beforeArchiveResponse.body).toMatchObject({
      success: true,
      data: expect.any(Array),
    });
    expect(
      beforeArchiveResponse.body.data.map(
        (conversation: { id: string }) => conversation.id,
      ),
    ).toEqual(
      expect.arrayContaining([archivedConversationId, activeConversationId]),
    );

    const archiveResponse = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${archivedConversationId}/archive`)
      .set('Cookie', ownerCookie)
      .set(csrfHeader)
      .expect(200);

    expect(archiveResponse.body).toMatchObject({
      success: true,
      data: null,
    });

    const archivedListResponse = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .query({ status: 'ARCHIVED' })
      .set('Cookie', ownerCookie)
      .expect(200);

    expect(archivedListResponse.body).toMatchObject({
      success: true,
      data: expect.any(Array),
    });
    expect(
      archivedListResponse.body.data.map(
        (conversation: { id: string }) => conversation.id,
      ),
    ).toContain(archivedConversationId);
    expect(
      archivedListResponse.body.data.map(
        (conversation: { id: string }) => conversation.id,
      ),
    ).not.toContain(activeConversationId);
    expect(
      archivedListResponse.body.data.every(
        (conversation: { status: string }) =>
          conversation.status === 'ARCHIVED',
      ),
    ).toBe(true);

    const activeListResponse = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .query({ status: 'ACTIVE' })
      .set('Cookie', ownerCookie)
      .expect(200);

    expect(activeListResponse.body).toMatchObject({
      success: true,
      data: expect.any(Array),
    });
    expect(
      activeListResponse.body.data.map(
        (conversation: { id: string }) => conversation.id,
      ),
    ).not.toContain(archivedConversationId);
    expect(
      activeListResponse.body.data.map(
        (conversation: { id: string }) => conversation.id,
      ),
    ).toContain(activeConversationId);
    expect(
      activeListResponse.body.data.every(
        (conversation: { status: string }) =>
          conversation.status === 'ACTIVE',
      ),
    ).toBe(true);

    const allListResponse = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .set('Cookie', ownerCookie)
      .expect(200);

    expect(allListResponse.body).toMatchObject({
      success: true,
      data: expect.any(Array),
    });
    expect(
      allListResponse.body.data.map(
        (conversation: { id: string }) => conversation.id,
      ),
    ).toEqual(
      expect.arrayContaining([archivedConversationId, activeConversationId]),
    );
  });

  it('제목 일부로 검색하고 불일치 검색에는 빈 목록을 반환한다', async () => {
    const matchingConversationId = await createConversation(
      ownerCookie,
      '요통 부분검색 고유표식 기록',
    );
    const unrelatedConversationId = await createConversation(
      ownerCookie,
      '편두통 별도 상담 기록',
    );

    const baselineResponse = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .set('Cookie', ownerCookie)
      .expect(200);

    expect(baselineResponse.body).toMatchObject({
      success: true,
      data: expect.any(Array),
    });
    expect(
      baselineResponse.body.data.map(
        (conversation: { id: string }) => conversation.id,
      ),
    ).toEqual(
      expect.arrayContaining([
        matchingConversationId,
        unrelatedConversationId,
      ]),
    );

    const matchingResponse = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .query({ query: '부분검색 고유표식' })
      .set('Cookie', ownerCookie)
      .expect(200);

    expect(matchingResponse.body).toMatchObject({
      success: true,
      data: expect.any(Array),
    });
    expect(matchingResponse.body.data).toHaveLength(1);
    expect(matchingResponse.body.data[0]).toMatchObject({
      id: matchingConversationId,
      title: '요통 부분검색 고유표식 기록',
    });
    expect(
      matchingResponse.body.data.map(
        (conversation: { id: string }) => conversation.id,
      ),
    ).not.toContain(unrelatedConversationId);

    const noMatchResponse = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .query({ query: '존재하지않는검색어' })
      .set('Cookie', ownerCookie)
      .expect(200);

    expect(noMatchResponse.body).toMatchObject({
      success: true,
      data: [],
    });
    expect(noMatchResponse.body.data).toHaveLength(0);
  });

  it('타 clinician의 수정과 보관은 404를 반환한다', async () => {
    const conversationId = await createConversation(
      ownerCookie,
      '소유권 보호 기록',
    );

    const ownerUpdateResponse = await request(app.getHttpServer())
      .patch(`/api/v1/conversations/${conversationId}`)
      .set('Cookie', ownerCookie)
      .set(csrfHeader)
      .send({ title: '소유 계정 수정 확인' })
      .expect(200);

    expect(ownerUpdateResponse.body).toMatchObject({
      success: true,
      data: {
        id: conversationId,
        title: '소유 계정 수정 확인',
      },
    });

    const ownerArchiveResponse = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/archive`)
      .set('Cookie', ownerCookie)
      .set(csrfHeader)
      .expect(200);

    expect(ownerArchiveResponse.body).toMatchObject({
      success: true,
      data: null,
    });

    const otherUpdateResponse = await request(app.getHttpServer())
      .patch(`/api/v1/conversations/${conversationId}`)
      .set('Cookie', otherClinicianCookie)
      .set(csrfHeader)
      .send({ title: '타인 계정 수정 시도' })
      .expect(404);

    expect(otherUpdateResponse.body).toMatchObject({
      success: false,
    });

    const otherArchiveResponse = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/archive`)
      .set('Cookie', otherClinicianCookie)
      .set(csrfHeader)
      .expect(404);

    expect(otherArchiveResponse.body).toMatchObject({
      success: false,
    });
  });

  it('쿠키 없는 수정 요청은 401을 반환한다', async () => {
    const conversationId = await createConversation(
      ownerCookie,
      '비인증 수정 차단 기록',
    );

    const ownerUpdateResponse = await request(app.getHttpServer())
      .patch(`/api/v1/conversations/${conversationId}`)
      .set('Cookie', ownerCookie)
      .set(csrfHeader)
      .send({ title: '인증 소유 계정 수정 확인' })
      .expect(200);

    expect(ownerUpdateResponse.body).toMatchObject({
      success: true,
      data: {
        id: conversationId,
        title: '인증 소유 계정 수정 확인',
      },
    });

    const unauthenticatedResponse = await request(app.getHttpServer())
      .patch(`/api/v1/conversations/${conversationId}`)
      .set(csrfHeader)
      .send({ title: '비인증 수정 시도' })
      .expect(401);

    expect(unauthenticatedResponse.body).toMatchObject({
      success: false,
    });
  });
});
