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

/** 값이 채워진 필드만 — 구조화 입력이자 patientFactors 검증의 유일한 원천이다 */
export function presentGuidanceProfileFields(
  _profile: PatientSnapshotPayload,
): GuidanceProfileField[] {
  throw new Error('not implemented');
}

/** 값이 비어 있는 필드명 — §7 missingInformation */
export function missingGuidanceProfileFields(_profile: PatientSnapshotPayload): string[] {
  throw new Error('not implemented');
}
