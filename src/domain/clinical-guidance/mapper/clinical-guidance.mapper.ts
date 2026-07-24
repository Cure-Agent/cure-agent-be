import { ClinicalGuidanceResponseDto } from '../dto/response/clinical-guidance.response.dto';
import { ClinicalGuidanceRow } from '../persistence/clinical-guidance.schema';

export function toClinicalGuidanceDto(row: ClinicalGuidanceRow): ClinicalGuidanceResponseDto {
  return {
    id: row.id,
    patientId: row.patientId,
    patientProfileSnapshotId: row.patientSnapshotId,
    summary: row.summary,
    considerations: row.considerations,
    safetyAlerts: row.safetyAlerts,
    missingInformation: row.missingInformation,
    reviewStatus: row.reviewStatus,
    generatedAt: row.createdAt.toISOString(),
  };
}
