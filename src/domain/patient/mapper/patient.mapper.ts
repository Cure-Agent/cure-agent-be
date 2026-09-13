import { PatientDetailResponseDto } from '../dto/response/patient-detail.response.dto';
import { PatientSummaryResponseDto } from '../dto/response/patient-summary.response.dto';
import { PatientRow } from '../persistence/patient.schema';
import type { PatientSnapshotPayload } from '../service/patient-snapshot.service';

/** 복호화된 민감 필드 묶음 — 서비스가 AesGcmUtil로 복원해 전달한다 */
export interface DecryptedPatientFields {
  diagnoses: string[];
  medications: string[];
  allergies: string[];
  clinicalNotes?: string;
}

export function toPatientSummary(row: PatientRow): PatientSummaryResponseDto {
  return {
    id: row.id,
    caseLabel: row.caseLabel,
    age: row.birthYear ? new Date().getFullYear() - row.birthYear : undefined,
    sex: row.sex ?? undefined,
    bmi: computeBmi(row.heightCm, row.weightKg),
    status: row.status,
  };
}

export function toPatientDetail(
  row: PatientRow,
  decrypted: DecryptedPatientFields,
): PatientDetailResponseDto {
  return {
    ...toPatientSummary(row),
    birthYear: row.birthYear ?? undefined,
    heightCm: row.heightCm ?? undefined,
    weightKg: row.weightKg ?? undefined,
    waistCm: row.waistCm ?? undefined,
    diagnoses: decrypted.diagnoses,
    medications: decrypted.medications,
    allergies: decrypted.allergies,
    clinicalNotes: decrypted.clinicalNotes,
    version: row.version,
  };
}

/**
 * 고정된 스냅샷의 내용을 상세 형태로 (docs/specs/51 환자 도구).
 *
 * 기록 필드는 **스냅샷이 고정한 값**이다 — 턴의 답변은 그 스냅샷 위에서 합성되므로, 같은 턴의 재시도가
 * 그 사이 수정된 원본을 돌려주면 답변과 고정 기록이 어긋난다. 스냅샷에 없는 보관 상태만 현재 행에서 온다.
 */
export function toPatientDetailFromSnapshot(
  current: PatientRow,
  payload: PatientSnapshotPayload,
): PatientDetailResponseDto {
  return toPatientDetail(
    {
      ...current,
      caseLabel: payload.caseLabel,
      birthYear: payload.birthYear,
      sex: payload.sex,
      heightCm: payload.heightCm,
      weightKg: payload.weightKg,
      waistCm: payload.waistCm,
      version: payload.patientVersion,
    },
    {
      diagnoses: payload.diagnoses,
      medications: payload.medications,
      allergies: payload.allergies,
      clinicalNotes: payload.clinicalNotes ?? undefined,
    },
  );
}

function computeBmi(heightCm: number | null, weightKg: number | null): number | undefined {
  if (!heightCm || !weightKg) return undefined;
  const meters = heightCm / 100;
  return Math.round((weightKg / (meters * meters)) * 10) / 10;
}
