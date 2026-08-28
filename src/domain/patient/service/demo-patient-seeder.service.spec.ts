// docs/specs/41 BE 수용 기준 1~3·7·29 동결 테스트 — 구현 중 수정 금지
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { demoSeedConfig } from '../../../global/config/demo-seed.config';
import { DemoPatientSeeder } from './demo-patient-seeder.service';

interface CapturedPatientRow {
  clinicId?: unknown;
  caseLabel?: unknown;
  birthYear?: unknown;
  sex?: unknown;
  heightCm?: unknown;
  weightKg?: unknown;
  diagnosesEncrypted?: unknown;
  medicationsEncrypted?: unknown;
  allergiesEncrypted?: unknown;
  clinicalNotesEncrypted?: unknown;
}

interface SeederHarness {
  moduleRef: TestingModule;
  service: DemoPatientSeeder;
  insert: jest.Mock;
  values: jest.Mock;
  rows: CapturedPatientRow[];
}

const SPEC_PATIENTS = [
  {
    caseLabel: 'CASE-001',
    birthYear: 1954,
    sex: 'FEMALE',
    heightCm: 163,
    weightKg: 55,
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
    diagnoses: ['류마티스 관절염'],
    medications: ['메토트렉세이트'],
    allergies: ['꽃가루'],
    clinicalNotes: undefined,
  },
] as const;

const SOURCE_QUESTIONS = [
  {
    id: 'evalgen-answerable-015',
    diagnosis: '골다공증',
    question:
      '골다공증 환자에게 골밀도나 통증 개선을 목적으로 침 치료를 고려할 때, 유침 시간은 보통 어느 정도로 잡는 것이 적절한가요?',
  },
  {
    id: 'evalgen-answerable-014',
    diagnosis: '주의력결핍 과잉행동장애',
    question:
      'ADHD 소아·청소년에서 한약 치료를 우선 검토할 수 있는 임상 상황은 어떤 경우인가요?',
  },
  {
    id: 'evalgen-answerable-114',
    diagnosis: '류마티스 관절염',
    question:
      '성인 류마티스 관절염 환자의 증상 완화를 위해 약침을 쓸 때, 시술 부위와 함께 어떤 취혈 원칙을 적용하고 봉약침 사용 전에는 어떤 안전 조치가 필요한가?',
  },
] as const;

function encrypted(plaintext: string): string {
  return `enc(${plaintext})`;
}

/**
 * TransactionManager의 구체적인 연결 접근자 이름과 무관하게, 시더가 받는 현재 연결에는
 * insert(table).values(rows)만 제공한다. 테스트가 DB 구현 세부를 흉내 내지는 않는다.
 */
function fakeTransactionManager(insert: jest.Mock): object {
  const conn = { insert };
  const connectionLike = new Proxy(
    function connectionAccessor(...args: unknown[]): unknown {
      const callback = args.find(
        (candidate): candidate is (connection: typeof conn) => unknown =>
          typeof candidate === 'function',
      );
      return callback ? callback(conn) : conn;
    },
    {
      get: (_target, property) => {
        if (property === 'then') return undefined;
        return Reflect.get(conn, property);
      },
    },
  );

  return new Proxy(
    {},
    {
      get: (_target, property) => (property === 'then' ? undefined : connectionLike),
    },
  );
}

async function createHarness(enabled: boolean): Promise<SeederHarness> {
  const rows: CapturedPatientRow[] = [];
  const values = jest.fn(async (input: CapturedPatientRow | CapturedPatientRow[]) => {
    rows.push(...(Array.isArray(input) ? input : [input]));
  });
  const insert = jest.fn((_table: unknown) => ({ values }));
  const transactionManager = fakeTransactionManager(insert);
  const aesGcm = {
    encrypt: jest.fn((plaintext: string) => encrypted(plaintext)),
  };

  const parameterTypes = Reflect.getMetadata('design:paramtypes', DemoPatientSeeder) as
    | unknown[]
    | undefined;
  const transactionManagerToken = parameterTypes?.[1];
  const aesGcmToken = parameterTypes?.[2];
  if (!transactionManagerToken || !aesGcmToken) {
    throw new Error('DemoPatientSeeder 생성자 주입 토큰을 찾지 못했습니다.');
  }

  const moduleRef = await Test.createTestingModule({
    providers: [
      DemoPatientSeeder,
      { provide: demoSeedConfig.KEY, useValue: { enabled } },
      { provide: transactionManagerToken as never, useValue: transactionManager },
      { provide: aesGcmToken as never, useValue: aesGcm },
    ],
  }).compile();

  return {
    moduleRef,
    service: moduleRef.get(DemoPatientSeeder),
    insert,
    values,
    rows,
  };
}

function configEnabled(): boolean {
  return (demoSeedConfig() as { enabled: boolean }).enabled;
}

function findEvalEntry(root: unknown, id: string): Record<string, unknown> | undefined {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === null || typeof candidate !== 'object') continue;

    if (Array.isArray(candidate)) {
      pending.push(...candidate);
      continue;
    }

    const record = candidate as Record<string, unknown>;
    if (record.id === id || record.caseId === id || record.evalId === id) return record;

    const keyedEntry = record[id];
    if (keyedEntry !== null && typeof keyedEntry === 'object' && !Array.isArray(keyedEntry)) {
      return keyedEntry as Record<string, unknown>;
    }
    pending.push(...Object.values(record));
  }
  return undefined;
}

describe('docs/specs/41: DemoPatientSeeder BE 수용 기준', () => {
  const originalDemoSeedEnabled = process.env.DEMO_SEED_ENABLED;

  afterEach(() => {
    if (originalDemoSeedEnabled === undefined) {
      delete process.env.DEMO_SEED_ENABLED;
    } else {
      process.env.DEMO_SEED_ENABLED = originalDemoSeedEnabled;
    }
  });

  it('기준 1: 꺼진 설정은 patients에 한 행도 쓰지 않는다', async () => {
    const disabled = await createHarness(false);
    await disabled.service.seed('clinic-disabled');

    expect(disabled.insert).not.toHaveBeenCalled();
    expect(disabled.values).not.toHaveBeenCalled();
    expect(disabled.rows).toHaveLength(0);
    await disabled.moduleRef.close();

    // 음성 단언이 빈 seed()에도 통과하지 않도록, 같은 경로의 켜진 대조군을 함께 잠근다.
    const enabled = await createHarness(true);
    await enabled.service.seed('clinic-enabled-control');
    expect(enabled.rows).toHaveLength(3);
    await enabled.moduleRef.close();
  });

  it('기준 2: env 미지정·빈 문자열은 false다', () => {
    delete process.env.DEMO_SEED_ENABLED;
    expect(configEnabled()).toBe(false);

    process.env.DEMO_SEED_ENABLED = '';
    expect(configEnabled()).toBe(false);

    // 팩토리가 상수 false인 빈 껍데기여도 통과하지 않게 방향의 대조군을 둔다.
    process.env.DEMO_SEED_ENABLED = 'true';
    expect(configEnabled()).toBe(true);
  });

  it("기준 3: 정확히 'true'만 true이고 나머지 값은 모두 false다", () => {
    for (const value of ['1', 'yes', 'True', 'false']) {
      process.env.DEMO_SEED_ENABLED = value;
      expect(configEnabled()).toBe(false);
    }

    process.env.DEMO_SEED_ENABLED = 'true';
    expect(configEnabled()).toBe(true);
  });

  it('기준 7: 삽입 전 행은 요청 clinicId를 가지며 명세 표의 세 환자다', async () => {
    const clinicId = 'clinic-requested-by-caller';
    const harness = await createHarness(true);
    await harness.service.seed(clinicId);

    expect(harness.rows).toHaveLength(3);
    expect(harness.rows.every((row) => row.clinicId === clinicId)).toBe(true);

    const actual = harness.rows
      .map((row) => ({
        clinicId: row.clinicId,
        caseLabel: row.caseLabel,
        birthYear: row.birthYear,
        sex: row.sex,
        heightCm: row.heightCm,
        weightKg: row.weightKg,
        diagnosesEncrypted: row.diagnosesEncrypted,
        medicationsEncrypted: row.medicationsEncrypted,
        allergiesEncrypted: row.allergiesEncrypted,
        clinicalNotesEncrypted: row.clinicalNotesEncrypted ?? null,
      }))
      .sort((left, right) => String(left.caseLabel).localeCompare(String(right.caseLabel)));

    const expected = SPEC_PATIENTS.map((patient) => ({
      clinicId,
      caseLabel: patient.caseLabel,
      birthYear: patient.birthYear,
      sex: patient.sex,
      heightCm: patient.heightCm,
      weightKg: patient.weightKg,
      diagnosesEncrypted: encrypted(JSON.stringify(patient.diagnoses)),
      medicationsEncrypted: encrypted(JSON.stringify(patient.medications)),
      allergiesEncrypted: encrypted(JSON.stringify(patient.allergies)),
      clinicalNotesEncrypted:
        patient.clinicalNotes === undefined ? null : encrypted(patient.clinicalNotes),
    }));
    expect(actual).toEqual(expected);
    await harness.moduleRef.close();
  });

  it('기준 29: 승인된 answerable 평가 문항 세 건의 원문을 자구까지 잠근다', async () => {
    const evalsetPath = resolve(process.cwd(), 'test/fixtures/rag-eval/evalset.json');
    const evalset = JSON.parse(readFileSync(evalsetPath, 'utf8')) as unknown;

    for (const source of SOURCE_QUESTIONS) {
      const entry = findEvalEntry(evalset, source.id);
      expect(entry).toBeDefined();
      expect(entry).toEqual(
        expect.objectContaining({
          kind: 'answerable',
          status: 'approved',
          question: source.question,
        }),
      );
    }

    // 평가셋만 이미 존재하는 스텁에서도 공허하게 통과하지 않도록, 그 출처가 가리키는 세 진단이
    // 실제 시딩 행에도 연결되는지 확인한다. 기대 진단은 구현 fixture가 아니라 명세 표의 상수다.
    const harness = await createHarness(true);
    await harness.service.seed('clinic-eval-source-contract');
    expect(harness.rows).toHaveLength(3);
    expect(
      harness.rows.map((row) => row.diagnosesEncrypted).sort(),
    ).toEqual(
      SOURCE_QUESTIONS.map((source) => encrypted(JSON.stringify([source.diagnosis]))).sort(),
    );
    await harness.moduleRef.close();
  });
});
