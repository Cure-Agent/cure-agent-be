import { Module } from '@nestjs/common';
import { ClinicianRepository } from './repository/clinician.repository';

@Module({
  providers: [ClinicianRepository],
  exports: [ClinicianRepository],
})
export class ClinicianModule {}
