// docs/specs/09 수용 기준 1~9 동결 테스트 — 구현 중 수정 금지
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PatientSnapshotService } from '../src/domain/patient/service/patient-snapshot.service';

const CSRF = { 'X-CSRF-Protection': '1' };
const MISSING_PATIENT_ID = '01J00000000000000000000000';

interface TestAuth {
  cookie: string;
  clinicId: string;
}

interface CreatePatientRequest {
  caseLabel: string;
  birthYear?: number;
  sex?: 'MALE' | 'FEMALE' | 'OTHER' | 'UNKNOWN';
  heightCm?: number;
  weightKg?: number;
  waistCm?: number;
  diagnoses: string[];
  medications: string[];
  allergies: string[];
  clinicalNotes?: string;
}

interface PatientDetail {
  id: string;
  caseLabel: string;
  birthYear?: number;
  age?: number;
  sex?: 'MALE' | 'FEMALE' | 'OTHER' | 'UNKNOWN';
  heightCm?: number;
  weightKg?: number;
  waistCm?: number;
  bmi?: number;
  diagnoses: string[];
  medications: string[];
  allergies: string[];
  clinicalNotes?: string;
  status: 'ACTIVE' | 'ARCHIVED';
  updatedAt: string;
  version: number;
}

const BASE_PATIENT: CreatePatientRequest = {
  caseLabel: '동결테스트 기본 환자',
  birthYear: 1988,
  sex: 'FEMALE',
  heightCm: 170,
  weightKg: 65,
  waistCm: 78,
  diagnoses: ['동결민감진단-고혈압', '동결민감진단-편두통'],
  medications: ['동결민감약물-암로디핀'],
  allergies: ['동결민감알레르기-페니실린'],
  clinicalNotes: '동결민감소견-야간 두통과 어지럼증을 호소함',
};

function expectEnvelope(body: unknown, success: boolean, code?: string): void {
  expect(body).toEqual(
    expect.objectContaining({
      success,
      code: code ?? expect.any(String),
      message: expect.any(String),
      timestamp: expect.any(String),
      traceId: expect.any(String),
    }),
  );
  expect(body).toHaveProperty('data');
  expect(body).toHaveProperty('page');
}

function expectCiphertext(value: unknown, plaintexts: string[]): void {
  expect(typeof value).toBe('string');
  const ciphertext = value as string;
  expect(ciphertext.startsWith('v1.')).toBe(true);
  for (const plaintext of plaintexts) {
    expect(ciphertext).not.toContain(plaintext);
  }
}

describe('docs/specs/09: Patient 수용 기준 1~9', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let authA: TestAuth;
  let authB: TestAuth;

  const server = () => app.getHttpServer();

  const signUp = async (
    email: string,
    licenseNumber: string,
    clinicName: string,
  ): Promise<TestAuth> => {
    const res = await request(server())
      .post('/api/v1/auth/signup')
      .set(CSRF)
      .send({
        email,
        password: 'password-1234',
        displayName: '환자테스트 의사',
        clinicName,
        licenseNumber,
        termsAccepted: true,
      })
      .expect(201);

    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    const cookie = cookies
      .map((raw) => raw.split(';')[0])
      .filter((pair) => pair.startsWith('access_token='))
      .join('; ');
    const clinicId = res.body.data.clinician.clinic.id as string;

    expect(cookie).toContain('access_token=');
    expect(clinicId).toEqual(expect.any(String));
    return { cookie, clinicId };
  };

  const createPatient = async (
    auth: TestAuth,
    overrides: Partial<CreatePatientRequest> = {},
  ): Promise<PatientDetail> => {
    const body: CreatePatientRequest = { ...BASE_PATIENT, ...overrides };
    const res = await request(server())
      .post('/api/v1/patients')
      .set(CSRF)
      .set('Cookie', auth.cookie)
      .send(body)
      .expect(201);

    expectEnvelope(res.body, true, 'CREATED');
    expect(res.body.page).toBeNull();
    expect(res.body.data).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        caseLabel: body.caseLabel,
        diagnoses: body.diagnoses,
        medications: body.medications,
        allergies: body.allergies,
        status: 'ACTIVE',
        updatedAt: expect.any(String),
        version: 1,
      }),
    );
    return res.body.data as PatientDetail;
  };

  beforeAll(async () => {
    [container, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();

    authA = await signUp('patient-owner-a@clinic.kr', 'LIC-PAT-1001', '환자테스트 A한의원');
    authB = await signUp('patient-owner-b@clinic.kr', 'LIC-PAT-1002', '환자테스트 B한의원');
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  it('기준 1: 생성 201 + Detail 파생값 + 민감 필드 DB 암호문/API 원문 복원', async () => {
    const body: CreatePatientRequest = {
      ...BASE_PATIENT,
      caseLabel: '기준1 암호화 환자',
      birthYear: 1990,
      heightCm: 170,
      weightKg: 65,
    };
    const patient = await createPatient(authA, body);

    expect(patient).toEqual(
      expect.objectContaining({
        caseLabel: body.caseLabel,
        birthYear: body.birthYear,
        age: new Date().getFullYear() - body.birthYear!,
        heightCm: 170,
        weightKg: 65,
        bmi: 22.5,
        diagnoses: body.diagnoses,
        medications: body.medications,
        allergies: body.allergies,
        clinicalNotes: body.clinicalNotes,
        version: 1,
      }),
    );

    const { rows } = await pool.query(
      `SELECT
        diagnoses_encrypted,
        medications_encrypted,
        allergies_encrypted,
        clinical_notes_encrypted
       FROM patients
       WHERE id = $1`,
      [patient.id],
    );
    expect(rows).toHaveLength(1);
    expectCiphertext(rows[0].diagnoses_encrypted, body.diagnoses);
    expectCiphertext(rows[0].medications_encrypted, body.medications);
    expectCiphertext(rows[0].allergies_encrypted, body.allergies);
    expectCiphertext(rows[0].clinical_notes_encrypted, [body.clinicalNotes!]);

    const detail = await request(server())
      .get(`/api/v1/patients/${patient.id}`)
      .set('Cookie', authA.cookie)
      .expect(200);
    expectEnvelope(detail.body, true);
    expect(detail.body.data).toEqual(
      expect.objectContaining({
        diagnoses: body.diagnoses,
        medications: body.medications,
        allergies: body.allergies,
        clinicalNotes: body.clinicalNotes,
      }),
    );
  });

  it('기준 2: Summary 목록 커서 페이지네이션 — size 제한, 다음 페이지, 중복 없음', async () => {
    const paginationAuth = await signUp(
      'patient-pagination@clinic.kr',
      'LIC-PAT-1003',
      '환자페이지 한의원',
    );
    const created = await Promise.all([
      createPatient(paginationAuth, { caseLabel: '페이지 환자 하나' }),
      createPatient(paginationAuth, { caseLabel: '페이지 환자 둘' }),
      createPatient(paginationAuth, { caseLabel: '페이지 환자 셋' }),
    ]);

    const page1 = await request(server())
      .get('/api/v1/patients')
      .query({ size: 2 })
      .set('Cookie', paginationAuth.cookie)
      .expect(200);
    expectEnvelope(page1.body, true);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.page).toEqual(
      expect.objectContaining({
        size: 2,
        hasNext: true,
        nextCursor: expect.any(String),
      }),
    );
    for (const summary of page1.body.data as Record<string, unknown>[]) {
      expect(summary).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          caseLabel: expect.any(String),
          age: expect.any(Number),
          sex: 'FEMALE',
          bmi: 22.5,
          status: 'ACTIVE',
          updatedAt: expect.any(String),
        }),
      );
      expect(summary).not.toHaveProperty('diagnoses');
      expect(summary).not.toHaveProperty('medications');
      expect(summary).not.toHaveProperty('allergies');
      expect(summary).not.toHaveProperty('clinicalNotes');
      expect(summary).not.toHaveProperty('version');
    }

    const page2 = await request(server())
      .get('/api/v1/patients')
      .query({ size: 2, cursor: page1.body.page.nextCursor })
      .set('Cookie', paginationAuth.cookie)
      .expect(200);
    expectEnvelope(page2.body, true);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.page).toEqual(
      expect.objectContaining({
        size: 2,
        hasNext: false,
        nextCursor: null,
      }),
    );

    const allIds = [...page1.body.data, ...page2.body.data].map(
      (item: { id: string }) => item.id,
    );
    expect(new Set(allIds).size).toBe(allIds.length);
    expect([...allIds].sort()).toEqual(created.map((patient) => patient.id).sort());
  });

  it('기준 3: query는 caseLabel을 부분일치 검색한다', async () => {
    const target1 = await createPatient(authA, { caseLabel: '서울 청룡검색 초진' });
    const target2 = await createPatient(authA, { caseLabel: '재진-청룡검색-야간' });
    await createPatient(authA, { caseLabel: '검색 결과에 없어야 하는 환자' });

    const res = await request(server())
      .get('/api/v1/patients')
      .query({ query: '청룡검색', size: 50 })
      .set('Cookie', authA.cookie)
      .expect(200);
    expectEnvelope(res.body, true);
    expect(res.body.data).toHaveLength(2);
    expect(
      (res.body.data as { caseLabel: string }[]).every((item) =>
        item.caseLabel.includes('청룡검색'),
      ),
    ).toBe(true);
    expect(
      (res.body.data as { id: string }[]).map((item) => item.id).sort(),
    ).toEqual([target1.id, target2.id].sort());
  });

  it('기준 4: 소유자 상세 200 확인 후 미존재 환자는 404 NOT_FOUND 봉투', async () => {
    const patient = await createPatient(authA, { caseLabel: '기준4 상세 환자' });

    const owned = await request(server())
      .get(`/api/v1/patients/${patient.id}`)
      .set('Cookie', authA.cookie)
      .expect(200);
    expectEnvelope(owned.body, true);
    expect(owned.body.data).toEqual(expect.objectContaining({ id: patient.id }));

    const missing = await request(server())
      .get(`/api/v1/patients/${MISSING_PATIENT_ID}`)
      .set('Cookie', authA.cookie)
      .expect(404);
    expectEnvelope(missing.body, false, 'NOT_FOUND');
    expect(missing.body).toEqual(
      expect.objectContaining({ data: null, page: null }),
    );
  });

  it('기준 5: 소유자 GET 200 선행 후 타 클리닉 GET/PATCH/archive는 모두 404', async () => {
    const patient = await createPatient(authA, { caseLabel: '클리닉 격리 환자' });

    const owned = await request(server())
      .get(`/api/v1/patients/${patient.id}`)
      .set('Cookie', authA.cookie)
      .expect(200);
    expectEnvelope(owned.body, true);
    expect(owned.body.data.id).toBe(patient.id);

    const foreignGet = await request(server())
      .get(`/api/v1/patients/${patient.id}`)
      .set('Cookie', authB.cookie)
      .expect(404);
    expectEnvelope(foreignGet.body, false, 'NOT_FOUND');

    const foreignPatch = await request(server())
      .patch(`/api/v1/patients/${patient.id}`)
      .set(CSRF)
      .set('Cookie', authB.cookie)
      .send({ caseLabel: '타 클리닉 수정 시도', version: patient.version })
      .expect(404);
    expectEnvelope(foreignPatch.body, false, 'NOT_FOUND');

    const foreignArchive = await request(server())
      .post(`/api/v1/patients/${patient.id}/archive`)
      .set(CSRF)
      .set('Cookie', authB.cookie)
      .expect(404);
    expectEnvelope(foreignArchive.body, false, 'NOT_FOUND');
    for (const response of [foreignGet, foreignPatch, foreignArchive]) {
      expect(response.body).toEqual(
        expect.objectContaining({ data: null, page: null }),
      );
    }
  });

  it('기준 6: PATCH version 성공 시 반영·증가, 구 version 재사용은 409와 currentVersion', async () => {
    const patient = await createPatient(authA, { caseLabel: '낙관적 잠금 환자' });

    const updated = await request(server())
      .patch(`/api/v1/patients/${patient.id}`)
      .set(CSRF)
      .set('Cookie', authA.cookie)
      .send({
        caseLabel: '낙관적 잠금 환자 수정',
        weightKg: 70,
        version: patient.version,
      })
      .expect(200);
    expectEnvelope(updated.body, true);
    expect(updated.body.data).toEqual(
      expect.objectContaining({
        id: patient.id,
        caseLabel: '낙관적 잠금 환자 수정',
        weightKg: 70,
        bmi: 24.2,
        version: patient.version + 1,
      }),
    );

    const conflict = await request(server())
      .patch(`/api/v1/patients/${patient.id}`)
      .set(CSRF)
      .set('Cookie', authA.cookie)
      .send({ waistCm: 80, version: patient.version })
      .expect(409);
    expectEnvelope(conflict.body, false, 'PATIENT_VERSION_CONFLICT');
    expect(conflict.body.data).toEqual(
      expect.objectContaining({ currentVersion: patient.version + 1 }),
    );
    expect(conflict.body.page).toBeNull();
  });

  it('기준 7: archive 후 PATCH 거부, ARCHIVED 목록 노출, unarchive 후 PATCH 성공', async () => {
    const patient = await createPatient(authA, { caseLabel: '보관 상태 환자' });

    const archived = await request(server())
      .post(`/api/v1/patients/${patient.id}/archive`)
      .set(CSRF)
      .set('Cookie', authA.cookie)
      .expect(200);
    expectEnvelope(archived.body, true);
    expect(archived.body.data).toBeNull();

    const rejected = await request(server())
      .patch(`/api/v1/patients/${patient.id}`)
      .set(CSRF)
      .set('Cookie', authA.cookie)
      .send({ caseLabel: '보관 중 수정 시도', version: patient.version })
      .expect(409);
    expectEnvelope(rejected.body, false, 'PATIENT_ARCHIVED');
    expect(rejected.body.data).toBeNull();
    expect(rejected.body.page).toBeNull();

    const archivedList = await request(server())
      .get('/api/v1/patients')
      .query({ status: 'ARCHIVED', size: 50 })
      .set('Cookie', authA.cookie)
      .expect(200);
    expectEnvelope(archivedList.body, true);
    expect(archivedList.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: patient.id, status: 'ARCHIVED' }),
      ]),
    );
    expect(
      (archivedList.body.data as { status: string }[]).every(
        (item) => item.status === 'ARCHIVED',
      ),
    ).toBe(true);

    const unarchived = await request(server())
      .post(`/api/v1/patients/${patient.id}/unarchive`)
      .set(CSRF)
      .set('Cookie', authA.cookie)
      .expect(200);
    expectEnvelope(unarchived.body, true);
    expect(unarchived.body.data).toBeNull();

    const current = await request(server())
      .get(`/api/v1/patients/${patient.id}`)
      .set('Cookie', authA.cookie)
      .expect(200);
    expectEnvelope(current.body, true);
    expect(current.body.data.status).toBe('ACTIVE');

    const patched = await request(server())
      .patch(`/api/v1/patients/${patient.id}`)
      .set(CSRF)
      .set('Cookie', authA.cookie)
      .send({
        clinicalNotes: '보관 해제 후 수정된 민감 임상 소견',
        version: current.body.data.version,
      })
      .expect(200);
    expectEnvelope(patched.body, true);
    expect(patched.body.data).toEqual(
      expect.objectContaining({
        id: patient.id,
        clinicalNotes: '보관 해제 후 수정된 민감 임상 소견',
        version: current.body.data.version + 1,
      }),
    );
  });

  it('기준 8: capture는 snapshotId를 반환하고 snapshot payload를 v1 암호문으로 저장', async () => {
    const body: CreatePatientRequest = {
      ...BASE_PATIENT,
      caseLabel: '스냅샷 평문부재 고유환자',
      diagnoses: ['스냅샷 고유민감진단-경추통'],
      medications: ['스냅샷 고유민감약물-나프록센'],
      allergies: ['스냅샷 고유민감알레르기-조영제'],
      clinicalNotes: '스냅샷 고유민감소견-좌측 상지 방사통',
    };
    const patient = await createPatient(authA, body);

    const captured = await app
      .get(PatientSnapshotService)
      .capture({ clinicId: authA.clinicId }, patient.id);
    expect(captured).toEqual({ snapshotId: expect.any(String) });

    const { rows } = await pool.query(
      `SELECT id, payload_encrypted
       FROM patient_profile_snapshots
       WHERE id = $1`,
      [captured.snapshotId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(captured.snapshotId);
    expectCiphertext(rows[0].payload_encrypted, [
      body.caseLabel,
      ...body.diagnoses,
      ...body.medications,
      ...body.allergies,
      body.clinicalNotes!,
    ]);
  });

  it('기준 9: 쿠키 없는 목록·생성 요청은 모두 401 UNAUTHORIZED', async () => {
    const list = await request(server()).get('/api/v1/patients').expect(401);
    expectEnvelope(list.body, false, 'UNAUTHORIZED');
    expect(list.body.data).toBeNull();
    expect(list.body.page).toBeNull();

    const create = await request(server())
      .post('/api/v1/patients')
      .set(CSRF)
      .send({ ...BASE_PATIENT, caseLabel: '미인증 생성 시도' })
      .expect(401);
    expectEnvelope(create.body, false, 'UNAUTHORIZED');
    expect(create.body.data).toBeNull();
    expect(create.body.page).toBeNull();
  });
});
