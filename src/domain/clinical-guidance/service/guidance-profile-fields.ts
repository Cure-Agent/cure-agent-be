/**
 * 참고안이 딛을 수 있는 임상 필드 어휘 (docs/specs/33).
 *
 * missingInformation과 **같은 목록**을 쓴다 — 한쪽은 값이 없는 것을, 다른 쪽은 값이 있는 것을
 * 싣는 여집합 관계다. 어휘가 갈라지면 「무엇이 빠졌는가」와 「무엇을 딛었는가」를 나란히 읽을 수 없다.
 */
import { GuidanceProfileField } from '../../../infrastructure/llm/guidance/guidance-structurer.port';
import { PatientSnapshotPayload } from '../../patient/service/patient-snapshot.service';

export const GUIDANCE_PROFILE_FIELD_LABELS = [
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

export type GuidanceProfileFieldLabel = (typeof GUIDANCE_PROFILE_FIELD_LABELS)[number];

/**
 * 라벨 → 값 추출. **순서는 §7 missingInformation의 기존 순서 그대로**이고, 값이 없으면 null이다.
 * 한 곳에서 읽으므로 두 목록이 서로 어긋날 수 없다.
 */
const FIELD_READERS: ReadonlyArray<{
  field: GuidanceProfileFieldLabel;
  read: (profile: PatientSnapshotPayload) => string | null;
}> = [
  { field: '출생연도', read: (p) => (p.birthYear === null ? null : String(p.birthYear)) },
  { field: '성별', read: (p) => p.sex },
  { field: '신장', read: (p) => (p.heightCm === null ? null : `${p.heightCm}cm`) },
  { field: '체중', read: (p) => (p.weightKg === null ? null : `${p.weightKg}kg`) },
  { field: '허리둘레', read: (p) => (p.waistCm === null ? null : `${p.waistCm}cm`) },
  { field: '진단명', read: (p) => joined(p.diagnoses) },
  { field: '투약 목록', read: (p) => joined(p.medications) },
  { field: '알레르기 이력', read: (p) => joined(p.allergies) },
  { field: '임상 메모', read: (p) => (p.clinicalNotes ? p.clinicalNotes : null) },
];

/** 값이 채워진 필드만 — 구조화 입력이자 patientFactors 검증의 유일한 원천이다 */
export function presentGuidanceProfileFields(
  profile: PatientSnapshotPayload,
): GuidanceProfileField[] {
  return FIELD_READERS.flatMap(({ field, read }) => {
    const value = read(profile);
    return value === null ? [] : [{ field, value }];
  });
}

/** 값이 비어 있는 필드명 — §7 missingInformation */
export function missingGuidanceProfileFields(profile: PatientSnapshotPayload): string[] {
  return FIELD_READERS.filter(({ read }) => read(profile) === null).map(({ field }) => field);
}

function joined(values: string[]): string | null {
  return values.length === 0 ? null : values.join(', ');
}
