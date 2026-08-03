// docs/specs/33 수용 기준 1·3·5·6 동결 테스트 — 구현 중 수정 금지

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
import { GUIDANCE_STRUCTURER } from '../src/infrastructure/llm/guidance/guidance-structurer.port';
import type {
  GuidanceStructureRequest,
  GuidanceStructureResult,
  GuidanceStructurer,
} from '../src/infrastructure/llm/guidance/guidance-structurer.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { yotongGuideline } from './fixtures/guideline-samples';
import { socialSignUp } from './fixtures/social-auth';

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

type CitationDto = {
  marker: number;
  evidenceId: string;
  guidelineTitle: string;
  guidelineVersion: string;
  sectionPath: string[];
  quote: string;
  sourceUrl: string;
};

type GuidanceDto = {
  id: string;
  patientId: string;
  patientProfileSnapshotId: string;
  summary: string;
  considerations: Array<{
    title: string;
    rationale: string;
    citations: CitationDto[];
    applicability?: string;
    patientFactors?: string[];
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
    citations?: CitationDto[];
    [key: string]: unknown;
  };
  guidance?: GuidanceDto;
  [key: string]: unknown;
};

const CSRF = { 'X-CSRF-Protection': '1' };
const ANSWERABLE_QUESTION = '만성 요통 환자에게 침 치료가 효과적인가요?';
const APPLICABILITIES = [
  'APPLICABLE',
  'CAUTION',
  'NOT_APPLICABLE',
] as const;
const PROFILE_FIELD_LABELS = [
  '출생연도',
  '성별',
  '신장',
  '체중',
  '허리둘레',
  '진단명',
  '투약 목록',
  '알레르기 이력',
  '임상 메모',
] as const;
const PRESENT_FIELDS_WITHOUT_ALLERGY = [
  '출생연도',
  '성별',
  '신장',
  '체중',
  '허리둘레',
  '진단명',
  '투약 목록',
  '임상 메모',
] as const;

class ThrowingGuidanceStructurer implements GuidanceStructurer {
  readonly model = 'throwing-guidance-structurer-test';
  calls = 0;

  structure(
    _request: GuidanceStructureRequest,
  ): Promise<GuidanceStructureResult> {
    this.calls += 1;
    return Promise.reject(new Error('의도된 guidance 구조화 오류'));
  }
}

class CountingGuidanceStructurer implements GuidanceStructurer {
  readonly model = 'counting-guidance-structurer-test';
  calls = 0;

  structure(
    request: GuidanceStructureRequest,
  ): Promise<GuidanceStructureResult> {
    this.calls += 1;
    return Promise.resolve({
      considerations: request.evidence.map((evidence) => ({
        title: evidence.guidelineTitle + ' 적용 판단',
        rationale: evidence.content,
        applicability: 'APPLICABLE',
        markers: [evidence.marker],
        patientFactors: request.profileFields.map((field) => field.field),
      })),
    });
  }
}

const parseSse = (raw: string): SseEvent[] =>
  raw
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => frame.split(/\r?\n/))
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as SseEvent);

describe('spec 33: 환자 프로필 × 인용 근거 적용 판단 (e2e)', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let defaultApp: INestApplication;
  let throwingApp: INestApplication;
  let countingApp: INestApplication;
  let defaultCookie: string;
  let throwingCookie: string;
  let countingCookie: string;
  let patientSequence = 0;

  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const throwingStructurer = new ThrowingGuidanceStructurer();
  const countingStructurer = new CountingGuidanceStructurer();

  const createApp = async (
    structurer?: GuidanceStructurer,
  ): Promise<INestApplication> => {
    const builder = Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry);

    if (structurer !== undefined) {
      builder.overrideProvider(GUIDANCE_STRUCTURER).useValue(structurer);
    }

    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    await bootstrapApp(app);
    return app;
  };

  const createPatient = async (
    app: INestApplication,
    cookie: string,
    overrides: Partial<PatientCreateBody> = {},
  ): Promise<PatientDto> => {
    patientSequence += 1;
    const body: PatientCreateBody = {
      caseLabel: 'SPEC33-CASE-' + String(patientSequence).padStart(3, '0'),
      birthYear: 1980,
      sex: 'FEMALE',
      heightCm: 165,
      weightKg: 62,
      waistCm: 80,
      diagnoses: ['만성 요통', '고혈압'],
      medications: ['암로디핀정'],
      allergies: [],
      clinicalNotes: '만성 요통이 지속되어 침 치료 적용을 검토 중',
      ...overrides,
    };

    const response = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set(CSRF)
      .set('Cookie', cookie)
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
    return response.body.data as PatientDto;
  };

  const createConversation = async (
    app: INestApplication,
    cookie: string,
    type: ConversationType,
    patientId?: string,
  ): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(CSRF)
      .set('Cookie', cookie)
      .send(patientId === undefined ? { type } : { type, patientId })
      .expect(201);

    expect(response.body).toMatchObject({ success: true });
    expect(response.body.data.id).toEqual(expect.any(String));
    return response.body.data.id as string;
  };

  const streamEvents = async (
    app: INestApplication,
    cookie: string,
    conversationId: string,
    content: string,
  ): Promise<SseEvent[]> => {
    const response = await request(app.getHttpServer())
      .post(
        '/api/v1/conversations/' +
          conversationId +
          '/messages/stream',
      )
      .set(CSRF)
      .set('Cookie', cookie)
      .send({
        content,
        clientRequestId: randomUUID(),
      })
      .expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    return parseSse(response.text);
  };

  const completedOf = (events: SseEvent[]): SseEvent => {
    const completed = events.find(
      (event) => event.eventType === 'answer.completed',
    );
    if (!completed) throw new Error('answer.completed 이벤트가 없습니다.');
    return completed;
  };

  const composerVersionOf = async (guidanceId: string): Promise<string> => {
    const result = await pool.query<{ composer_version: string }>(
      'SELECT composer_version FROM clinical_guidances WHERE id = $1',
      [guidanceId],
    );
    expect(result.rowCount).toBe(1);
    return result.rows[0].composer_version;
  };

  beforeAll(async () => {
    [postgresContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);

    process.env.DATABASE_URL = postgresContainer.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();
    process.env.OPENAI_API_KEY = '';

    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await migrate(drizzle(pool), {
      migrationsFolder: 'drizzle/migrations',
    });

    defaultApp = await createApp();
    throwingApp = await createApp(throwingStructurer);
    countingApp = await createApp(countingStructurer);

    await defaultApp.get(GuidelineIngestService).ingest(yotongGuideline);

    defaultCookie = (
      await socialSignUp(defaultApp, {
        email: 'spec33-default@clinic.kr',
        displayName: '기본구조화의',
        clinicName: '기본구조화한의원',
        licenseNumber: 'LIC-3301',
      })
    ).cookie;
    throwingCookie = (
      await socialSignUp(throwingApp, {
        email: 'spec33-throwing@clinic.kr',
        displayName: '폴백검증의',
        clinicName: '폴백검증한의원',
        licenseNumber: 'LIC-3302',
      })
    ).cookie;
    countingCookie = (
      await socialSignUp(countingApp, {
        email: 'spec33-counting@clinic.kr',
        displayName: '호출경계의',
        clinicName: '호출경계한의원',
        licenseNumber: 'LIC-3303',
      })
    ).cookie;
  });

  afterAll(async () => {
    await countingApp?.close();
    await throwingApp?.close();
    await defaultApp?.close();
    await pool?.end();
    await Promise.all([
      postgresContainer?.stop(),
      redisContainer?.stop(),
    ]);

    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
  });

  describe('기준 1: 기본 fake 구조화 해피패스', () => {
    let completed: SseEvent;
    let guidance: GuidanceDto;

    beforeAll(async () => {
      const patient = await createPatient(defaultApp, defaultCookie, {
        allergies: [],
        clinicalNotes: '알레르기 병력은 없고 만성 요통의 침 치료를 검토 중',
      });
      const conversationId = await createConversation(
        defaultApp,
        defaultCookie,
        'PATIENT_GUIDANCE',
        patient.id,
      );
      const events = await streamEvents(
        defaultApp,
        defaultCookie,
        conversationId,
        ANSWERABLE_QUESTION,
      );
      completed = completedOf(events);
      expect(completed.guidance).toBeDefined();
      guidance = completed.guidance as GuidanceDto;
    });

    it('기준 1a: 모든 consideration에 허용된 applicability 3값 중 하나가 있다', () => {
      expect(guidance.considerations.length).toBeGreaterThanOrEqual(1);
      guidance.considerations.forEach((consideration) => {
        expect(consideration.applicability).toBeDefined();
        expect(APPLICABILITIES).toContain(consideration.applicability);
      });
    });

    it('기준 1b: 모든 consideration에 비어 있지 않은 patientFactors가 있다', () => {
      expect(guidance.considerations.length).toBeGreaterThanOrEqual(1);
      guidance.considerations.forEach((consideration) => {
        expect(Array.isArray(consideration.patientFactors)).toBe(true);
        expect(consideration.patientFactors?.length).toBeGreaterThan(0);
      });
    });

    it('기준 1c: patientFactors는 9개 어휘 중 실제로 채워진 필드만 쓰고 missingInformation과 겹치지 않는다', () => {
      const factors = guidance.considerations.flatMap(
        (consideration) => consideration.patientFactors ?? [],
      );
      const missing = new Set(guidance.missingInformation);

      // 양성 대조: 폴백처럼 patientFactors가 아예 없는 응답은 아래 부분집합 검사를 통과할 수 없다.
      expect(factors.length).toBeGreaterThan(0);
      expect(guidance.missingInformation).toContain('알레르기 이력');
      factors.forEach((factor) => {
        expect(PROFILE_FIELD_LABELS).toContain(
          factor as (typeof PROFILE_FIELD_LABELS)[number],
        );
        expect(PRESENT_FIELDS_WITHOUT_ALLERGY).toContain(
          factor as (typeof PRESENT_FIELDS_WITHOUT_ALLERGY)[number],
        );
        expect(missing.has(factor)).toBe(false);
      });
      expect(factors).not.toContain('알레르기 이력');
    });

    it('기준 1d: 각 항목은 답변이 실제 인용한 marker의 citation을 하나 이상 가진다', () => {
      const answerMarkers = new Set(
        (completed.message?.citations ?? []).map((citation) => citation.marker),
      );

      expect(answerMarkers.size).toBeGreaterThan(0);
      // 결정적 폴백도 citation 부분집합만은 만족하므로 구조화 채택 양성 대조를 함께 둔다.
      expect(
        guidance.considerations.every(
          (consideration) => consideration.applicability !== undefined,
        ),
      ).toBe(true);
      guidance.considerations.forEach((consideration) => {
        expect(consideration.citations.length).toBeGreaterThan(0);
        consideration.citations.forEach((citation) => {
          expect(answerMarkers.has(citation.marker)).toBe(true);
        });
      });
    });

    it('기준 1e: 구조화가 채택된 행은 composer_version을 guidance-v1으로 기록한다', async () => {
      await expect(composerVersionOf(guidance.id)).resolves.toBe(
        'guidance-v1',
      );
    });
  });

  describe('기준 3: 구조화 실패 시 결정적 폴백', () => {
    let events: SseEvent[];
    let completed: SseEvent;
    let guidance: GuidanceDto;
    let callsForRequest = 0;

    beforeAll(async () => {
      const patient = await createPatient(throwingApp, throwingCookie, {
        allergies: ['페니실린'],
        clinicalNotes: '페니실린 알레르기 병력이 있는 만성 요통 환자',
      });
      const conversationId = await createConversation(
        throwingApp,
        throwingCookie,
        'PATIENT_GUIDANCE',
        patient.id,
      );
      const callsBefore = throwingStructurer.calls;
      events = await streamEvents(
        throwingApp,
        throwingCookie,
        conversationId,
        ANSWERABLE_QUESTION,
      );
      callsForRequest = throwingStructurer.calls - callsBefore;
      completed = completedOf(events);
      expect(completed.guidance).toBeDefined();
      guidance = completed.guidance as GuidanceDto;
    });

    it('기준 3a: 주입한 구조화 예외가 error 이벤트로 번지지 않고 guidance를 실은 answer.completed에 도달한다', () => {
      expect(events.some((event) => event.eventType === 'error')).toBe(false);
      expect(completed.eventType).toBe('answer.completed');
      expect(completed.guidance).toBeDefined();
      // 양성 대조: 구조화기가 호출되지 않은 현재 스텁의 정상 완료는 이 테스트를 통과하지 못한다.
      expect(callsForRequest).toBeGreaterThan(0);
    });

    it('기준 3b: 예외 폴백 행은 composer_version을 deterministic-v1으로 기록한다', async () => {
      await expect(composerVersionOf(guidance.id)).resolves.toBe(
        'deterministic-v1',
      );
      expect(callsForRequest).toBeGreaterThan(0);
    });

    it('기준 3c: 결정적 폴백 consideration에는 구조화 전용 필드가 없다', () => {
      expect(guidance.considerations.length).toBeGreaterThanOrEqual(1);
      guidance.considerations.forEach((consideration) => {
        expect(consideration.applicability).toBeUndefined();
        expect(consideration.patientFactors).toBeUndefined();
      });
      expect(callsForRequest).toBeGreaterThan(0);
    });

    it('기준 3d: 결정적 폴백에서도 summary와 비어 있지 않은 consideration 계약을 유지한다', () => {
      expect(guidance.summary.trim().length).toBeGreaterThan(0);
      expect(guidance.considerations.length).toBeGreaterThanOrEqual(1);
      guidance.considerations.forEach((consideration) => {
        expect(consideration.title.trim().length).toBeGreaterThan(0);
        expect(consideration.rationale.trim().length).toBeGreaterThan(0);
        expect(Array.isArray(consideration.citations)).toBe(true);
      });
      expect(callsForRequest).toBeGreaterThan(0);
    });

    it('기준 3e: 결정적 폴백에서도 환자의 페니실린 알레르기 안전 경고를 유지한다', () => {
      expect(
        guidance.safetyAlerts.filter((alert) =>
          alert.description.includes('페니실린'),
        ).length,
      ).toBeGreaterThanOrEqual(1);
      expect(callsForRequest).toBeGreaterThan(0);
    });
  });

  it('기준 5: GUIDELINE_QA는 구조화기를 호출하지 않되 같은 앱의 PATIENT_GUIDANCE는 호출한다', async () => {
    countingStructurer.calls = 0;

    const qaConversationId = await createConversation(
      countingApp,
      countingCookie,
      'GUIDELINE_QA',
    );
    const qaEvents = await streamEvents(
      countingApp,
      countingCookie,
      qaConversationId,
      ANSWERABLE_QUESTION,
    );
    const qaCompleted = completedOf(qaEvents);

    expect(countingStructurer.calls).toBe(0);
    expect(qaCompleted.guidance).toBeUndefined();

    const patient = await createPatient(countingApp, countingCookie);
    const patientConversationId = await createConversation(
      countingApp,
      countingCookie,
      'PATIENT_GUIDANCE',
      patient.id,
    );
    const patientEvents = await streamEvents(
      countingApp,
      countingCookie,
      patientConversationId,
      ANSWERABLE_QUESTION,
    );
    const patientCompleted = completedOf(patientEvents);

    expect(patientCompleted.guidance).toBeDefined();
    // 같은 카운터의 양성 대조라서 아무 경로도 호출하지 않는 스텁은 통과하지 못한다.
    expect(countingStructurer.calls).toBeGreaterThanOrEqual(1);
  });

  it('기준 6: 구조화 성공이 채택된 같은 응답에도 결정적 알레르기 안전 경고가 남는다', async () => {
    const patient = await createPatient(defaultApp, defaultCookie, {
      allergies: ['페니실린'],
      clinicalNotes: '페니실린 알레르기 병력이 있는 만성 요통 환자',
    });
    const conversationId = await createConversation(
      defaultApp,
      defaultCookie,
      'PATIENT_GUIDANCE',
      patient.id,
    );
    const completed = completedOf(
      await streamEvents(
        defaultApp,
        defaultCookie,
        conversationId,
        ANSWERABLE_QUESTION,
      ),
    );

    expect(completed.guidance).toBeDefined();
    const guidance = completed.guidance as GuidanceDto;
    expect(
      guidance.safetyAlerts.filter((alert) =>
        alert.description.includes('페니실린'),
      ).length,
    ).toBeGreaterThanOrEqual(1);

    // 같은 응답이 폴백이 아니라 구조화 성공 경로였다는 필수 양성 대조다.
    await expect(composerVersionOf(guidance.id)).resolves.toBe('guidance-v1');
    expect(guidance.considerations.length).toBeGreaterThanOrEqual(1);
    guidance.considerations.forEach((consideration) => {
      expect(APPLICABILITIES).toContain(consideration.applicability);
    });
  });
});
