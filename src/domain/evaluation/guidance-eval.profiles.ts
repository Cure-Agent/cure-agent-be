/**
 * 참고안 구조화 측정용 합성 프로필 (docs/specs/33 측정 계획).
 *
 * 실환자 스냅샷을 쓰지 않는다 — §4.5 암호화 대상을 오프라인 도구로 끌어내지 않기 위함이고,
 * 결측 조합을 의도적으로 만들어야 「두 다리 중 환자 쪽이 빈 경우」를 덮을 수 있기 때문이다.
 * 12종은 진단·투약·알레르기·신체계측·메모의 유무 조합에서 판정이 갈릴 축만 고른 것이다.
 */
import { PatientSnapshotPayload } from '../patient/service/patient-snapshot.service';

const CAPTURED_AT = '2026-08-03T00:00:00.000Z';

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

export const GUIDANCE_EVAL_PROFILES: readonly PatientSnapshotPayload[] = [
  profile('P01-완전', {
    birthYear: 1972,
    sex: 'FEMALE',
    heightCm: 161,
    weightKg: 68,
    waistCm: 88,
    diagnoses: ['만성 요통', '제2형 당뇨병'],
    medications: ['메트포르민', '아세트아미노펜'],
    allergies: ['페니실린'],
    clinicalNotes: '요통이 3개월 이상 지속, 야간통은 없음',
  }),
  profile('P02-진단만', { diagnoses: ['만성 요통'] }),
  profile('P03-투약만', { medications: ['와파린'] }),
  profile('P04-알레르기만', { allergies: ['아스피린'] }),
  profile('P05-진단+투약', {
    diagnoses: ['고혈압'],
    medications: ['암로디핀'],
  }),
  profile('P06-진단+알레르기', {
    diagnoses: ['알레르기 비염'],
    allergies: ['집먼지진드기'],
  }),
  profile('P07-투약+알레르기', {
    medications: ['와파린', '아스피린'],
    allergies: ['설파제'],
  }),
  profile('P08-임신메모', {
    sex: 'FEMALE',
    birthYear: 1994,
    clinicalNotes: '임신 8주, 산과 추적 중',
  }),
  profile('P09-고령다약제', {
    birthYear: 1941,
    sex: 'MALE',
    diagnoses: ['골관절염', '만성 신장병 3기'],
    medications: ['트라마돌', '푸로세미드', '아토르바스타틴', '레보티록신'],
    clinicalNotes: '신기능 저하로 용량 조절 이력 있음',
  }),
  profile('P10-계측만', {
    birthYear: 1988,
    sex: 'MALE',
    heightCm: 178,
    weightKg: 94,
    waistCm: 102,
  }),
  // 전 필드 결측 — 환자 다리를 세울 수 없으므로 **폴백이 정답**이다
  profile('P11-전결측', {}),
  profile('P12-계측결측', {
    diagnoses: ['월경통'],
    medications: ['이부프로펜'],
    allergies: ['조개류'],
    clinicalNotes: '초경 이후 지속된 원발성 월경통',
  }),
];
