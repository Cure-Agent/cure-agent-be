/**
 * 라이브 데모용 가상 환자 3건 (docs/specs/41).
 *
 * 진단명이 **계약이다.** 프론트가 이 문자열로 「환자 맞춤 대화」의 추천 질의문을 고르고
 * (`features/ask-guideline/lib/suggested-prompts.ts`), 세 진단 모두 적재된 지침 원문
 * (골다공증 51청크·주의력결핍 과잉행동장애 194·류마티스 관절염 53)에 대응한다 — 그래서
 * 데모에서 던지는 질문이 기권이 아니라 인용 붙은 답변으로 끝난다. 진단명을 바꾸면 프론트의
 * 매핑과 근거 코퍼스 양쪽이 함께 어긋나므로 셋을 같이 확인해야 한다.
 *
 * **생년은 상수다** (2026년 기준 72·11·64세를 역산한 값, 사용자 확정). 응답의 `age`는
 * 「올해 - 생년」 파생이므로(`patient.mapper.ts`) 해가 바뀌면 데모 환자도 한 살씩 먹는다 —
 * 시딩 시점 연도에서 역산하면 나이를 고정할 수 있지만, 이 데모의 예상 수명 안에서는 그
 * 드리프트가 문제되지 않아 읽기 쉬운 상수 쪽을 택했다. 나이가 진단의 임상적 맥락을 이루므로
 * (ADHD 소아, 골다공증 고령) 몇 해가 지나 관계가 어색해지면 그때 이 값을 갱신한다.
 */
export interface DemoPatientFixture {
  caseLabel: string;
  /** 2026년에 각각 72·11·64세로 보이도록 잡은 값 */
  birthYear: number;
  sex: 'MALE' | 'FEMALE';
  heightCm: number;
  weightKg: number;
  diagnoses: string[];
  medications: string[];
  allergies: string[];
  clinicalNotes?: string;
}

export const DEMO_PATIENTS: readonly DemoPatientFixture[] = [
  {
    caseLabel: 'CASE-001',
    birthYear: 1954,
    sex: 'FEMALE',
    heightCm: 163,
    weightKg: 55,
    diagnoses: ['골다공증'],
    medications: ['알렌드로네이트'],
    allergies: ['아토피'],
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
  },
];
