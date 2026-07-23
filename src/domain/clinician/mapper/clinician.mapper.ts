import { ClinicRow } from '../persistence/clinic.schema';
import { ClinicianRow } from '../persistence/clinician.schema';
import { ClinicianResponseDto } from '../dto/response/clinician.response.dto';

export function toClinicianResponse(
  clinician: ClinicianRow,
  clinic: ClinicRow,
): ClinicianResponseDto {
  return {
    id: clinician.id,
    email: clinician.email,
    displayName: clinician.displayName,
    clinic: { id: clinic.id, name: clinic.name },
    verificationStatus: clinician.verificationStatus,
  };
}
