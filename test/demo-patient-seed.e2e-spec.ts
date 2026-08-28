// docs/specs/41 BE 수용 기준 4~15 동결 테스트 — 구현 중 수정 금지
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
import { demoSeedConfig } from '../src/global/config/demo-seed.config';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { joinByInvitation, socialSignUp, TestSession } from './fixtures/social-auth';

const CSRF = { 'X-CSRF-Protection': '1' };

const SPEC_PATIENTS = [
  {
    caseLabel: 'CASE-001',
    birthYear: 1954,
    sex: 'FEMALE',
    heightCm: 163,
    weightKg: 55,
    bmi: 20.7,
    diagnoses: ['골다공증'],
    medications: ['알렌드로네이트'],
    allergies: ['아토피'],
    clinicalNotes: undefined,
  },
  {
    caseLabel: 'CASE-002',
    birthYear: 2015,
    sex: 'MALE',
    heightCm: 145,
    weightKg: 42,
    bmi: 20,
    diagnoses: ['주의력결핍 과잉행동장애'],
    medications: [],
    allergies: ['땅콩', '견과류'],
    clinicalNotes: '경도~중등도 증상, 보호자가 양약을 선호하지 않음',
  },
  {
    caseLabel: 'CASE-003',
    birthYear: 1962,
    sex: 'FEMALE',
    heightCm: 160,
    weightKg: 56,
    bmi: 21.9,
    diagnoses: ['류마티스 관절염'],
    medications: ['메토트렉세이트'],
    allergies: ['꽃가루'],
    clinicalNotes: undefined,
  },
] as const;

interface PatientSummary {
  id: string;
  caseLabel: string;
}

interface PatientDetail extends PatientSummary {
  birthYear: number;
  sex: 'MALE' | 'FEMALE';
  heightCm: number;
  weightKg: number;
  bmi: number;
  diagnoses: string[];
  medications: string[];
  allergies: string[];
  clinicalNotes?: string;
}

describe('docs/specs/41: 데모 환자 시딩 BE 수용 기준 4~15', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let owner: TestSession;

  const server = () => app.getHttpServer();

  const listPatients = async (cookie: string): Promise<PatientSummary[]> => {
    const response = await request(server())
      .get('/api/v1/patients')
      .query({ size: 50 })
      .set('Cookie', cookie)
      .expect(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    return response.body.data as PatientSummary[];
  };

  const patientByLabel = async (label: string): Promise<PatientSummary> => {
    const patients = await listPatients(owner.cookie);
    const patient = patients.find((candidate) => candidate.caseLabel === label);
    expect(patient).toBeDefined();
    if (!patient) throw new Error(`${label} 데모 환자를 찾지 못했습니다.`);
    return patient;
  };

  const patientDetail = async (patient: PatientSummary): Promise<PatientDetail> => {
    const response = await request(server())
      .get(`/api/v1/patients/${patient.id}`)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({ id: patient.id, caseLabel: patient.caseLabel }),
    );
    return response.body.data as PatientDetail;
  };

  const allPatientDetails = async (): Promise<PatientDetail[]> => {
    const patients = await listPatients(owner.cookie);
    expect(patients).toHaveLength(3);
    return Promise.all(patients.map((patient) => patientDetail(patient)));
  };

  const createConversation = async (
    type: 'PATIENT_GUIDANCE' | 'GUIDELINE_QA',
    patientId?: string,
  ): Promise<string> => {
    const response = await request(server())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', owner.cookie)
      .send(patientId === undefined ? { type } : { type, patientId })
      .expect(201);
    const data = response.body.data as
      | { id?: unknown; conversation?: { id?: unknown } }
      | undefined;
    const id = data?.id ?? data?.conversation?.id;
    expect(typeof id).toBe('string');
    if (typeof id !== 'string') throw new Error(`${type} 대화 id가 응답에 없습니다.`);
    return id;
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(demoSeedConfig.KEY)
      .useValue({ enabled: true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);

    owner = await socialSignUp(app, {
      email: 'demo-seed-owner@clinic.kr',
      providerId: 'demo-seed-owner-provider',
      displayName: '데모 시딩 개설자',
      clinicName: '데모 시딩 한의원',
      licenseNumber: 'LIC-DEMO-SEED-OWNER',
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  it('기준 4: 플래그를 켜고 실제 socialSignUp으로 개설한 클리닉의 목록은 3건이다', async () => {
    const patients = await listPatients(owner.cookie);
    expect(patients).toHaveLength(3);
  });

  it('기준 5: id DESC 목록 순서는 CASE-001 → CASE-002 → CASE-003이다', async () => {
    const patients = await listPatients(owner.cookie);
    expect(patients.map((patient) => patient.caseLabel)).toEqual([
      'CASE-001',
      'CASE-002',
      'CASE-003',
    ]);
  });

  it('기준 6: 실제 초대 발급·소비로 합류한 구성원도 같은 3건만 보며 6건이 되지 않는다', async () => {
    const member = await joinByInvitation(app, owner, {
      email: 'demo-seed-member@clinic.kr',
      providerId: 'demo-seed-member-provider',
      displayName: '데모 시딩 합류자',
      licenseNumber: 'LIC-DEMO-SEED-MEMBER',
    });

    expect(member.clinicId).toBe(owner.clinicId);
    const patients = await listPatients(member.cookie);
    expect(patients).toHaveLength(3);
    expect(patients.map((patient) => patient.caseLabel)).toEqual([
      'CASE-001',
      'CASE-002',
      'CASE-003',
    ]);
  });

  it('기준 8: 세 상세 응답은 명세 표의 진단·투약·알레르기를 평문 배열로 돌려준다', async () => {
    const details = await allPatientDetails();
    const actual = details.map((detail) => ({
      caseLabel: detail.caseLabel,
      diagnoses: detail.diagnoses,
      medications: detail.medications,
      allergies: detail.allergies,
    }));

    expect(actual).toEqual(
      SPEC_PATIENTS.map((patient) => ({
        caseLabel: patient.caseLabel,
        diagnoses: [...patient.diagnoses],
        medications: [...patient.medications],
        allergies: [...patient.allergies],
      })),
    );
  });

  it('기준 9: CASE-002 상세의 clinicalNotes는 명세 문자열 그대로다', async () => {
    const patient = await patientByLabel('CASE-002');
    const detail = await patientDetail(patient);
    expect(detail.clinicalNotes).toBe(
      '경도~중등도 증상, 보호자가 양약을 선호하지 않음',
    );
  });

  it('기준 10: CASE-001·CASE-003의 clinical_notes_encrypted는 null이다', async () => {
    const { rows } = await pool.query(
      `SELECT case_label, clinical_notes_encrypted
       FROM patients
       WHERE clinic_id = $1 AND case_label IN ('CASE-001', 'CASE-003')
       ORDER BY case_label ASC`,
      [owner.clinicId],
    );

    expect(rows).toEqual([
      { case_label: 'CASE-001', clinical_notes_encrypted: null },
      { case_label: 'CASE-003', clinical_notes_encrypted: null },
    ]);
  });

  it('기준 11: 세 diagnoses_encrypted는 v1. 암호문이며 진단명 평문을 포함하지 않는다', async () => {
    const { rows } = await pool.query(
      `SELECT case_label, diagnoses_encrypted
       FROM patients
       WHERE clinic_id = $1
       ORDER BY case_label ASC`,
      [owner.clinicId],
    );

    expect(rows).toHaveLength(3);
    for (const expected of SPEC_PATIENTS) {
      const row = rows.find(
        (candidate: { case_label: string }) => candidate.case_label === expected.caseLabel,
      ) as { diagnoses_encrypted?: unknown } | undefined;
      expect(row).toBeDefined();
      expect(typeof row?.diagnoses_encrypted).toBe('string');
      const ciphertext = row?.diagnoses_encrypted as string;
      expect(ciphertext.startsWith('v1.')).toBe(true);
      for (const diagnosis of expected.diagnoses) {
        expect(ciphertext).not.toContain(diagnosis);
      }
    }
  });

  it('기준 12: 세 상세의 birthYear·sex는 명세 표와 같다', async () => {
    const details = await allPatientDetails();
    expect(
      details.map((detail) => ({
        caseLabel: detail.caseLabel,
        birthYear: detail.birthYear,
        sex: detail.sex,
      })),
    ).toEqual(
      SPEC_PATIENTS.map((patient) => ({
        caseLabel: patient.caseLabel,
        birthYear: patient.birthYear,
        sex: patient.sex,
      })),
    );
  });

  it('기준 13: 세 상세에 신장·체중과 그 값으로 계산된 bmi가 실린다', async () => {
    const details = await allPatientDetails();
    expect(
      details.map((detail) => ({
        caseLabel: detail.caseLabel,
        heightCm: detail.heightCm,
        weightKg: detail.weightKg,
        bmi: detail.bmi,
      })),
    ).toEqual(
      SPEC_PATIENTS.map((patient) => ({
        caseLabel: patient.caseLabel,
        heightCm: patient.heightCm,
        weightKg: patient.weightKg,
        bmi: patient.bmi,
      })),
    );
  });

  it('기준 14: PATIENT_GUIDANCE 상세 응답에는 연결된 patientId가 실린다', async () => {
    const patient = await patientByLabel('CASE-001');
    const patientConversationId = await createConversation('PATIENT_GUIDANCE', patient.id);

    const patientConversation = await request(server())
      .get(`/api/v1/conversations/${patientConversationId}`)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(patientConversation.body.data).toHaveProperty('patientId', patient.id);
  });

  it('기준 15: GUIDELINE_QA 상세 응답에는 patientId 키 자체가 없다', async () => {
    const patient = await patientByLabel('CASE-001');
    const patientConversationId = await createConversation('PATIENT_GUIDANCE', patient.id);
    const guidelineConversationId = await createConversation('GUIDELINE_QA');

    // 부재 단언이 patientId를 전혀 매핑하지 않는 빈 구현에도 통과하지 않도록 양성 대조를 둔다.
    const patientConversation = await request(server())
      .get(`/api/v1/conversations/${patientConversationId}`)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(patientConversation.body.data).toHaveProperty('patientId', patient.id);

    const guidelineConversation = await request(server())
      .get(`/api/v1/conversations/${guidelineConversationId}`)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(guidelineConversation.body.data).not.toHaveProperty('patientId');
  });
});
