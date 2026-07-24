// docs/specs/10 수용 기준 1~8 동결 테스트 — 구현 중 수정 금지

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
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
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { AesGcmUtil } from '../src/global/security/crypto/aes-gcm.util';
import { yotongGuideline } from './fixtures/guideline-samples';

type ConversationType = 'PATIENT_GUIDANCE' | 'GUIDELINE_QA';

type PatientCreateBody = {
  caseLabel: string;
  birthYear: number;
  sex: 'FEMALE' | 'MALE';
  heightCm: number;
  weightKg: number;
  waistCm: number;
  diagnoses: string[];
  medications: string[];
  allergies: string[];
  clinicalNotes: string;
};

type PatientDto = PatientCreateBody & {
  id: string;
  version: number;
};

type CitationDto = Record<string, unknown>;

type GuidanceDto = {
  id: string;
  patientId: string;
  patientProfileSnapshotId: string;
  summary: string;
  considerations: Array<{
    title: string;
    rationale: string;
    citations: CitationDto[];
  }>;
  safetyAlerts: Array<{
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    description: string;
    citations: CitationDto[];
  }>;
  missingInformation: string[];
  reviewStatus: string;
  generatedAt: string;
};

type SseEvent = {
  eventType: string;
  message?: {
    id?: string;
    answerKind?: string;
    [key: string]: unknown;
  };
  guidance?: GuidanceDto;
  [key: string]: unknown;
};

const parseSse = (raw: string): SseEvent[] =>
  raw
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => frame.split(/\r?\n/))
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as SseEvent);

describe('Clinical guidance (e2e)', () => {
  let app: INestApplication;
  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let ownerCookie: string;
  let otherClinicCookie: string;
  let patientSequence = 0;

  const signUp = async ({
    email,
    displayName,
    clinicName,
    licenseNumber,
  }: {
    email: string;
    displayName: string;
    clinicName: string;
    licenseNumber: string;
  }): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .set('X-CSRF-Protection', '1')
      .send({
        email,
        password: 'password-1234',
        displayName,
        clinicName,
        licenseNumber,
        termsAccepted: true,
      })
      .expect(201);

    const setCookies = response.headers['set-cookie'] as unknown as string[] | undefined;
    const accessTokenCookie = setCookies
      ?.map((cookie) => cookie.split(';')[0])
      .find((cookie) => cookie.startsWith('access_token='));

    expect(accessTokenCookie).toBeDefined();
    return accessTokenCookie as string;
  };

  const createPatient = async (
    overrides: Partial<PatientCreateBody> = {},
  ): Promise<PatientDto> => {
    patientSequence += 1;
    const body: PatientCreateBody = {
      caseLabel: `CASE-${String(patientSequence).padStart(3, '0')}`,
      birthYear: 1980,
      sex: 'FEMALE',
      heightCm: 165,
      weightKg: 62,
      waistCm: 80,
      diagnoses: ['고혈압'],
      medications: ['암로디핀정'],
      allergies: [],
      clinicalNotes: '임상 지침 생성 동결 테스트용 환자',
      ...overrides,
    };

    const response = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('Cookie', ownerCookie)
      .set('X-CSRF-Protection', '1')
      .send(body)
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      data: {
        caseLabel: body.caseLabel,
        weightKg: body.weightKg,
      },
    });
    expect(response.body.data.id).toEqual(expect.any(String));
    expect(response.body.data.version).toEqual(expect.any(Number));

    return response.body.data as PatientDto;
  };

  const createConversation = async (
    cookie: string,
    type: ConversationType,
    patientId?: string,
  ): Promise<string> => {
    const body =
      patientId === undefined ? { type } : { type, patientId };
    const response = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1')
      .send(body)
      .expect(201);

    expect(response.body).toMatchObject({ success: true });
    expect(response.body.data.id).toEqual(expect.any(String));
    return response.body.data.id as string;
  };

  const streamCompleted = async (
    cookie: string,
    conversationId: string,
    content: string,
  ): Promise<SseEvent> => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/messages/stream`)
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1')
      .send({
        content,
        clientRequestId: randomUUID(),
      })
      .expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = parseSse(response.text);
    const completed = events.find(
      (event) => event.eventType === 'answer.completed',
    );
    expect(completed).toBeDefined();
    return completed as SseEvent;
  };

  const generateGuidance = async (
    patient: PatientDto,
    content = '이 환자에게 적용할 임상 지침을 알려 주세요.',
  ): Promise<GuidanceDto> => {
    const conversationId = await createConversation(
      ownerCookie,
      'PATIENT_GUIDANCE',
      patient.id,
    );
    const completed = await streamCompleted(
      ownerCookie,
      conversationId,
      content,
    );

    expect(completed.guidance).toBeDefined();
    return completed.guidance as GuidanceDto;
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
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    await app.init();

    await app.get(GuidelineIngestService).ingest(yotongGuideline);

    ownerCookie = await signUp({
      email: 'guidance-owner@example.com',
      displayName: '김의사',
      clinicName: '소유 클리닉',
      licenseNumber: 'LIC-0042',
    });
    otherClinicCookie = await signUp({
      email: 'guidance-other@example.com',
      displayName: '이의사',
      clinicName: '타 클리닉',
      licenseNumber: 'LIC-0043',
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await Promise.all([
      postgresContainer?.stop(),
      redisContainer?.stop(),
    ]);
  });

  it('1. PATIENT_GUIDANCE 대화 생성 계약과 patientId 경계를 동결한다', async () => {
    const patient = await createPatient();

    await createConversation(ownerCookie, 'PATIENT_GUIDANCE', patient.id);

    const missingPatientId = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set('Cookie', ownerCookie)
      .set('X-CSRF-Protection', '1')
      .send({ type: 'PATIENT_GUIDANCE' })
      .expect(400);

    expect(missingPatientId.body).toMatchObject({
      success: false,
      code: 'BAD_REQUEST',
    });

    const otherClinicPatient = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set('Cookie', otherClinicCookie)
      .set('X-CSRF-Protection', '1')
      .send({
        type: 'PATIENT_GUIDANCE',
        patientId: patient.id,
      })
      .expect(404);

    expect(otherClinicPatient.body).toMatchObject({
      success: false,
    });
  });

  it('2. PATIENT_GUIDANCE 스트림 완료 이벤트와 영속화 계약을 동결한다', async () => {
    const patient = await createPatient();
    const conversationId = await createConversation(
      ownerCookie,
      'PATIENT_GUIDANCE',
      patient.id,
    );
    const completed = await streamCompleted(
      ownerCookie,
      conversationId,
      '환자 상태를 근거 지침과 함께 검토해 주세요.',
    );

    expect(completed.message).toMatchObject({
      answerKind: 'CLINICAL_GUIDANCE',
    });
    expect(completed.guidance).toBeDefined();

    const guidance = completed.guidance as GuidanceDto;
    expect(guidance).toMatchObject({
      patientId: patient.id,
      reviewStatus: 'DRAFT',
    });
    expect(guidance.id).toEqual(expect.any(String));
    expect(guidance.patientProfileSnapshotId).toEqual(expect.any(String));
    expect(guidance.generatedAt).toEqual(expect.any(String));
    expect(guidance.summary.trim().length).toBeGreaterThan(0);
    expect(guidance.considerations.length).toBeGreaterThanOrEqual(1);
    guidance.considerations.forEach((consideration) => {
      expect(consideration.title.trim().length).toBeGreaterThan(0);
      expect(consideration.rationale.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(consideration.citations)).toBe(true);
    });
    expect(Array.isArray(guidance.safetyAlerts)).toBe(true);
    guidance.safetyAlerts.forEach((alert) => {
      expect(['INFO', 'WARNING', 'CRITICAL']).toContain(alert.severity);
      expect(alert.description).toEqual(expect.any(String));
      expect(Array.isArray(alert.citations)).toBe(true);
    });
    expect(Array.isArray(guidance.missingInformation)).toBe(true);

    const guidanceRows = await pool.query<{
      id: string;
      message_id: string;
      patient_id: string;
      patient_snapshot_id: string;
      clinic_id: string;
      review_status: string;
    }>(
      `
        SELECT
          id,
          message_id,
          patient_id,
          patient_snapshot_id,
          clinic_id,
          review_status
        FROM clinical_guidances
        WHERE id = $1
      `,
      [guidance.id],
    );

    expect(guidanceRows.rowCount).toBe(1);
    expect(guidanceRows.rows[0]).toMatchObject({
      id: guidance.id,
      patient_id: patient.id,
      patient_snapshot_id: guidance.patientProfileSnapshotId,
      review_status: 'DRAFT',
    });
    expect(guidanceRows.rows[0].message_id).toEqual(expect.any(String));
    expect(guidanceRows.rows[0].clinic_id).toEqual(expect.any(String));

    const snapshotRows = await pool.query<{ id: string }>(
      `
        SELECT id
        FROM patient_profile_snapshots
        WHERE id = $1
      `,
      [guidance.patientProfileSnapshotId],
    );
    expect(snapshotRows.rowCount).toBe(1);
  });

  it('3. 환자 변경 뒤에도 생성 시점의 스냅샷은 불변이다', async () => {
    const initialWeightKg = 61;
    const changedWeightKg = 73;
    const patient = await createPatient({ weightKg: initialWeightKg });
    const guidance = await generateGuidance(patient);

    const updatedPatient = await request(app.getHttpServer())
      .patch(`/api/v1/patients/${patient.id}`)
      .set('Cookie', ownerCookie)
      .set('X-CSRF-Protection', '1')
      .send({
        version: patient.version,
        weightKg: changedWeightKg,
      })
      .expect(200);

    expect(updatedPatient.body).toMatchObject({
      success: true,
      data: {
        id: patient.id,
        weightKg: changedWeightKg,
      },
    });

    const snapshotRows = await pool.query<{
      payload_encrypted: string;
    }>(
      `
        SELECT payload_encrypted
        FROM patient_profile_snapshots
        WHERE id = $1
      `,
      [guidance.patientProfileSnapshotId],
    );
    expect(snapshotRows.rowCount).toBe(1);

    const decrypted = app
      .get(AesGcmUtil)
      .decrypt(snapshotRows.rows[0].payload_encrypted);
    const snapshotPayload = JSON.parse(decrypted) as {
      weightKg: number;
    };

    expect(snapshotPayload.weightKg).toBe(initialWeightKg);
    expect(snapshotPayload.weightKg).not.toBe(changedWeightKg);
  });

  it('4. 페니실린 알레르기를 임상 지침 안전 경고에 반영한다', async () => {
    const patient = await createPatient({
      allergies: ['페니실린'],
      clinicalNotes: '페니실린 알레르기 병력이 있음',
    });
    const guidance = await generateGuidance(
      patient,
      '약물 관련 안전 사항을 포함해 지침을 제안해 주세요.',
    );

    expect(
      guidance.safetyAlerts.filter((alert) =>
        alert.description.includes('페니실린'),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('5. GUIDELINE_QA 완료 이벤트에는 guidance를 노출하지 않는다', async () => {
    const patient = await createPatient();
    const patientGuidanceConversationId = await createConversation(
      ownerCookie,
      'PATIENT_GUIDANCE',
      patient.id,
    );
    const patientGuidanceCompleted = await streamCompleted(
      ownerCookie,
      patientGuidanceConversationId,
      '환자 맞춤 임상 지침을 생성해 주세요.',
    );
    expect(patientGuidanceCompleted.guidance).toBeDefined();

    const guidelineQaConversationId = await createConversation(
      ownerCookie,
      'GUIDELINE_QA',
    );
    const guidelineQaCompleted = await streamCompleted(
      ownerCookie,
      guidelineQaConversationId,
      '고혈압 환자의 생활습관 권고를 알려 주세요.',
    );

    expect(guidelineQaCompleted.guidance).toBeUndefined();
  });

  it('6. 임상 지침을 ACCEPTED로 검토하고 조회 결과와 DB에 반영한다', async () => {
    const patient = await createPatient();
    const guidance = await generateGuidance(patient);

    const reviewed = await request(app.getHttpServer())
      .post(`/api/v1/clinical-guidance/${guidance.id}/reviews`)
      .set('Cookie', ownerCookie)
      .set('X-CSRF-Protection', '1')
      .send({
        decision: 'ACCEPTED',
        note: '적절함',
      })
      .expect(200);

    expect(reviewed.body).toMatchObject({
      success: true,
      data: {
        reviewStatus: 'ACCEPTED',
      },
    });

    const reviewRows = await pool.query<{
      guidance_id: string;
      clinician_id: string;
      decision: string;
      note: string;
    }>(
      `
        SELECT guidance_id, clinician_id, decision, note
        FROM guidance_reviews
        WHERE guidance_id = $1
      `,
      [guidance.id],
    );

    expect(reviewRows.rowCount).toBe(1);
    expect(reviewRows.rows[0]).toMatchObject({
      guidance_id: guidance.id,
      clinician_id: expect.any(String),
      decision: 'ACCEPTED',
      note: '적절함',
    });

    const fetched = await request(app.getHttpServer())
      .get(`/api/v1/clinical-guidance/${guidance.id}`)
      .set('Cookie', ownerCookie)
      .expect(200);

    expect(fetched.body).toMatchObject({
      success: true,
      data: {
        id: guidance.id,
        reviewStatus: 'ACCEPTED',
      },
    });
  });

  it('7. 이미 검토한 임상 지침의 재검토를 거부하고 상태를 보존한다', async () => {
    const patient = await createPatient();
    const guidance = await generateGuidance(patient);

    const firstReview = await request(app.getHttpServer())
      .post(`/api/v1/clinical-guidance/${guidance.id}/reviews`)
      .set('Cookie', ownerCookie)
      .set('X-CSRF-Protection', '1')
      .send({
        decision: 'ACCEPTED',
        note: '최초 검토',
      })
      .expect(200);

    expect(firstReview.body).toMatchObject({
      success: true,
      data: {
        reviewStatus: 'ACCEPTED',
      },
    });

    const secondReview = await request(app.getHttpServer())
      .post(`/api/v1/clinical-guidance/${guidance.id}/reviews`)
      .set('Cookie', ownerCookie)
      .set('X-CSRF-Protection', '1')
      .send({
        decision: 'REJECTED',
        note: '재검토 시도',
      })
      .expect(409);

    expect(secondReview.body).toMatchObject({
      success: false,
      code: 'GUIDANCE_ALREADY_REVIEWED',
    });

    const fetched = await request(app.getHttpServer())
      .get(`/api/v1/clinical-guidance/${guidance.id}`)
      .set('Cookie', ownerCookie)
      .expect(200);

    expect(fetched.body).toMatchObject({
      success: true,
      data: {
        id: guidance.id,
        reviewStatus: 'ACCEPTED',
      },
    });
  });

  it('8. 임상 지침 조회·검토의 클리닉 격리와 인증 경계를 동결한다', async () => {
    const patient = await createPatient();
    const guidance = await generateGuidance(patient);

    const ownerGet = await request(app.getHttpServer())
      .get(`/api/v1/clinical-guidance/${guidance.id}`)
      .set('Cookie', ownerCookie)
      .expect(200);

    expect(ownerGet.body).toMatchObject({
      success: true,
      data: {
        id: guidance.id,
        reviewStatus: 'DRAFT',
      },
    });

    const otherClinicGet = await request(app.getHttpServer())
      .get(`/api/v1/clinical-guidance/${guidance.id}`)
      .set('Cookie', otherClinicCookie)
      .expect(404);

    expect(otherClinicGet.body).toMatchObject({
      success: false,
    });

    const otherClinicReview = await request(app.getHttpServer())
      .post(`/api/v1/clinical-guidance/${guidance.id}/reviews`)
      .set('Cookie', otherClinicCookie)
      .set('X-CSRF-Protection', '1')
      .send({
        decision: 'ACCEPTED',
        note: '타 클리닉 검토 시도',
      })
      .expect(404);

    expect(otherClinicReview.body).toMatchObject({
      success: false,
    });

    const unauthenticatedGet = await request(app.getHttpServer())
      .get(`/api/v1/clinical-guidance/${guidance.id}`)
      .expect(401);

    expect(unauthenticatedGet.body).toMatchObject({
      success: false,
    });
  });
});
