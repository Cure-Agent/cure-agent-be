import { PatientDetailResponseDto } from '../dto/response/patient-detail.response.dto';
import { PatientSummaryResponseDto } from '../dto/response/patient-summary.response.dto';
import { PatientRow } from '../persistence/patient.schema';

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
    updatedAt: row.updatedAt.toISOString(),
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

function computeBmi(heightCm: number | null, weightKg: number | null): number | undefined {
  if (!heightCm || !weightKg) return undefined;
  const meters = heightCm / 100;
  return Math.round((weightKg / (meters * meters)) * 10) / 10;
}
