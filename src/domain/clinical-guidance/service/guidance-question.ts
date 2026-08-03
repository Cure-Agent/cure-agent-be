/**
 * PATIENT_GUIDANCE 질문 합성 (§5.6).
 * 스트림과 측정(docs/specs/33)이 같은 문자열을 만들어야 «무엇을 쟀는가»가 갈라지지 않는다.
 */
import { PatientSnapshotPayload } from '../../patient/service/patient-snapshot.service';

/** 복호화 프로필을 질문 앞에 합성 — 프로필은 LLM 컨텍스트로만 쓰고 저장하지 않는다 (§4.5) */
export function composeGuidanceQuestion(
  profile: PatientSnapshotPayload,
  question: string,
): string {
  const parts = [
    `진단: ${profile.diagnoses.join(', ') || '정보 없음'}`,
    `투약: ${profile.medications.join(', ') || '정보 없음'}`,
    `알레르기: ${profile.allergies.join(', ') || '없음'}`,
  ];
  if (profile.clinicalNotes) parts.push(`임상 메모: ${profile.clinicalNotes}`);
  return `[환자 프로필] ${parts.join(' / ')}\n${question}`;
}
