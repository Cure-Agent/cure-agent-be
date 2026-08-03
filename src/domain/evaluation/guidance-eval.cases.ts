/**
 * 참고안 구조화 측정용 커레이션 케이스 (docs/specs/33 — 2차 사이클 규약).
 *
 * 1차의 순환 배정을 폐기한다 — 프로필이 문항 주제와 대부분 어긋나(조현병 질문 × 요통 환자)
 * 측정의 주 표본이 「부정합 → 해당없음」 판정에 몰렸고, 정작 가치 제안인 「근거 조건 × 환자 값의
 * 실제 접점」은 9건에서만 관찰됐다. 2차는 문항별로 프로필을 손으로 붙인다:
 *
 * - `aligned` 24 — 진단·상태가 문항 주제와 만나는 케이스. 가치 성립 게이트(⑷)의 표본이다.
 *   일부는 프로브를 겸한다: 011(연령 경계 — 85세 vs 「50~80세」 조건, 산술 판정 금지 규칙),
 *   005·031(무관 필드 노이즈 — 빈 다리 인용 금지 규칙), 003·024·030(항응고·면역억제 병용).
 * - `mismatch` 4 — 주제 부정합 유지 표본. 1차가 이 거동을 20+건으로 이미 쟀으므로 축소한다.
 * - `missing` 2 — 전결측. **폴백이 정답**이라 폴백률 분모에서 제외하며, structured로 나오면
 *   두 다리 강제가 깨진 것이므로 즉시 실패다.
 *
 * 실환자 스냅샷을 쓰지 않는 이유는 1차와 같다 — §4.5 암호화 대상을 오프라인 도구로 끌어내지
 * 않고, 프로브 조합은 합성으로만 만들 수 있다.
 */
import { PatientSnapshotPayload } from '../patient/service/patient-snapshot.service';

const CAPTURED_AT = '2026-08-03T00:00:00.000Z';

export type GuidanceEvalExpectation = 'aligned' | 'mismatch' | 'missing';

export interface GuidanceEvalCaseFixture {
  itemId: string;
  expectation: GuidanceEvalExpectation;
  profile: PatientSnapshotPayload;
}

function profile(
  caseLabel: string,
  overrides: Partial<PatientSnapshotPayload>,
): PatientSnapshotPayload {
  return {
    patientId: `eval-${caseLabel}`,
    caseLabel,
    birthYear: null,
    sex: null,
    heightCm: null,
    weightKg: null,
    waistCm: null,
    diagnoses: [],
    medications: [],
    allergies: [],
    clinicalNotes: null,
    patientVersion: 1,
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}

function aligned(
  itemId: string,
  caseLabel: string,
  overrides: Partial<PatientSnapshotPayload>,
): GuidanceEvalCaseFixture {
  return { itemId, expectation: 'aligned', profile: profile(caseLabel, overrides) };
}

function mismatch(
  itemId: string,
  caseLabel: string,
  overrides: Partial<PatientSnapshotPayload>,
): GuidanceEvalCaseFixture {
  return { itemId, expectation: 'mismatch', profile: profile(caseLabel, overrides) };
}

export const GUIDANCE_EVAL_CASES: readonly GuidanceEvalCaseFixture[] = [
  // ── aligned 24 ─────────────────────────────────────────────────────────────
  aligned('evalgen-answerable-002', 'A02-근막통증증후군', {
    birthYear: 1985,
    sex: 'FEMALE',
    diagnoses: ['근막통증증후군'],
    clinicalNotes: '승모근·견갑거근 압통점, 통증 3주 지속',
  }),
  aligned('evalgen-answerable-003', 'A03-슬관절치환술후+와파린', {
    birthYear: 1958,
    sex: 'FEMALE',
    diagnoses: ['우측 슬관절 전치환술 후'],
    medications: ['와파린'],
    clinicalNotes: '수술 후 3주차, 재활치료 병행 중',
  }),
  aligned('evalgen-answerable-005', 'A05-손목터널+무관알레르기', {
    birthYear: 1978,
    sex: 'FEMALE',
    diagnoses: ['손목터널증후군'],
    allergies: ['아스피린'],
    clinicalNotes: '야간 손저림으로 수면 곤란',
  }),
  aligned('evalgen-answerable-008', 'A08-소아식욕부진', {
    birthYear: 2020,
    sex: 'MALE',
    heightCm: 110,
    weightKg: 17,
    diagnoses: ['식욕부진'],
    clinicalNotes: '또래 대비 체중 백분위 낮음, 편식 심함',
  }),
  aligned('evalgen-answerable-010', 'A10-월경전증후군', {
    birthYear: 1996,
    sex: 'FEMALE',
    diagnoses: ['월경전증후군'],
    clinicalNotes: '월경 전 유방통·과민·부종 반복',
  }),
  aligned('evalgen-answerable-011', 'A11-전립선비대+85세(연령경계)', {
    birthYear: 1941,
    sex: 'MALE',
    diagnoses: ['전립선비대증'],
    clinicalNotes: 'IPSS 15점, 야간뇨 3회, 급성 요저류 없음',
  }),
  aligned('evalgen-answerable-014', 'A14-소아ADHD', {
    birthYear: 2015,
    sex: 'MALE',
    diagnoses: ['주의력결핍 과잉행동장애'],
    clinicalNotes: '경도~중등도 증상, 보호자가 양약 비선호',
  }),
  aligned('evalgen-answerable-015', 'A15-골다공증', {
    birthYear: 1954,
    sex: 'FEMALE',
    diagnoses: ['골다공증'],
    medications: ['알렌드로네이트'],
  }),
  aligned('evalgen-answerable-016', 'A16-원발성불면', {
    birthYear: 1970,
    sex: 'FEMALE',
    diagnoses: ['원발성 불면증'],
    clinicalNotes: '입면 곤란 3개월, 가슴 두근거림과 건망 동반',
  }),
  aligned('evalgen-answerable-017', 'A17-범불안장애', {
    birthYear: 1988,
    sex: 'MALE',
    diagnoses: ['범불안장애'],
  }),
  aligned('evalgen-answerable-018', 'A18-수족냉증', {
    birthYear: 1990,
    sex: 'FEMALE',
    diagnoses: ['수족냉증'],
    clinicalNotes: '겨울철 손발 시림 악화',
  }),
  aligned('evalgen-answerable-019', 'A19-원인불명난임', {
    birthYear: 1991,
    sex: 'FEMALE',
    diagnoses: ['원인불명 난임'],
    clinicalNotes: '난임 검사상 특이 소견 없음',
  }),
  aligned('evalgen-answerable-020', 'A20-임신오조+임신8주', {
    birthYear: 1994,
    sex: 'FEMALE',
    diagnoses: ['임신오조'],
    clinicalNotes: '임신 8주, 경미한 오심·구토, 산과 추적 중',
  }),
  aligned('evalgen-answerable-021', 'A21-파킨슨+레보도파', {
    birthYear: 1948,
    sex: 'MALE',
    diagnoses: ['특발성 파킨슨병'],
    medications: ['레보도파'],
    clinicalNotes: '진전 등 운동증상 위주',
  }),
  aligned('evalgen-answerable-023', 'A23-유방암치료후피로', {
    birthYear: 1968,
    sex: 'FEMALE',
    diagnoses: ['유방암 수술 후'],
    clinicalNotes: '항암 종료 후 피로·전신 쇠약 지속',
  }),
  aligned('evalgen-answerable-024', 'A24-류마티스+MTX', {
    birthYear: 1962,
    sex: 'FEMALE',
    diagnoses: ['류마티스 관절염'],
    medications: ['메토트렉세이트'],
  }),
  aligned('evalgen-answerable-025', 'A25-회전근개봉합술후', {
    birthYear: 1965,
    sex: 'MALE',
    heightCm: 172,
    weightKg: 75,
    diagnoses: ['회전근개 봉합술 후'],
    clinicalNotes: '수술 후 6주차 재활기',
  }),
  aligned('evalgen-answerable-027', 'A27-알레르기비염', {
    birthYear: 2001,
    sex: 'MALE',
    diagnoses: ['알레르기 비염'],
    allergies: ['집먼지진드기'],
  }),
  aligned('evalgen-answerable-028', 'A28-교통사고경항부염좌', {
    birthYear: 1983,
    sex: 'FEMALE',
    diagnoses: ['교통사고 후 경항부 염좌'],
    clinicalNotes: '추돌사고 5일째, 목·어깨 통증',
  }),
  aligned('evalgen-answerable-029', 'A29-대상포진흉협부', {
    birthYear: 1955,
    sex: 'MALE',
    diagnoses: ['대상포진'],
    clinicalNotes: '좌측 흉협부 발진·통증',
  }),
  aligned('evalgen-answerable-030', 'A30-견비통+와파린', {
    birthYear: 1960,
    sex: 'FEMALE',
    diagnoses: ['견비통'],
    medications: ['와파린'],
  }),
  aligned('evalgen-answerable-031', 'A31-경항통+무관알레르기', {
    birthYear: 1980,
    sex: 'MALE',
    diagnoses: ['경항통'],
    allergies: ['페니실린'],
  }),
  aligned('evalgen-answerable-032', 'A32-고혈압+암로디핀', {
    birthYear: 1972,
    sex: 'MALE',
    diagnoses: ['고혈압'],
    medications: ['암로디핀'],
  }),
  aligned('evalgen-answerable-033', 'A33-산후풍의심', {
    birthYear: 1993,
    sex: 'FEMALE',
    diagnoses: ['산후풍 의심'],
    clinicalNotes: '출산 2개월, 관절통과 시린 증상',
  }),
  // ── mismatch 4 ─────────────────────────────────────────────────────────────
  mismatch('evalgen-answerable-001', 'M01-조현병질문×요통환자', {
    birthYear: 1975,
    sex: 'FEMALE',
    diagnoses: ['만성 요통'],
  }),
  mismatch('evalgen-answerable-009', 'M09-안면마비질문×고혈압환자', {
    birthYear: 1970,
    sex: 'MALE',
    diagnoses: ['고혈압'],
    medications: ['암로디핀'],
  }),
  mismatch('evalgen-answerable-012', 'M12-척추측만질문×소화불량환자', {
    birthYear: 1992,
    sex: 'FEMALE',
    diagnoses: ['기능성 소화불량'],
  }),
  mismatch('evalgen-answerable-036', 'M36-편두통질문×슬관절염환자', {
    birthYear: 1950,
    sex: 'FEMALE',
    diagnoses: ['퇴행성 슬관절염'],
  }),
  // ── missing 2 — 폴백이 정답 ────────────────────────────────────────────────
  { itemId: 'evalgen-answerable-022', expectation: 'missing', profile: profile('X22-전결측', {}) },
  { itemId: 'evalgen-answerable-026', expectation: 'missing', profile: profile('X26-전결측', {}) },
];
