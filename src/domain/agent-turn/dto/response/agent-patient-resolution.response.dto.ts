import { PatientDetailResponseDto } from '../../../patient/dto/response/patient-detail.response.dto';

export const AGENT_PATIENT_OUTCOMES = ['RESOLVED', 'NOT_FOUND', 'AMBIGUOUS'] as const;
export type AgentPatientOutcome = (typeof AGENT_PATIENT_OUTCOMES)[number];

/**
 * 환자 도구의 결과 (docs/specs/51). 해석 실패는 오류가 아니라 결과다 — 에이전트가 `patient_unresolved`
 * 기권으로 턴을 닫아야 하므로 4xx로 내면 수락의 4xx(인증·스코프)와 섞인다.
 * `patient`는 `RESOLVED`에만 실리고, 턴에 고정한 스냅샷과 같은 읽기에서 나온다.
 */
export class AgentPatientResolutionResponseDto {
  outcome!: AgentPatientOutcome;
  patient?: PatientDetailResponseDto;
}
