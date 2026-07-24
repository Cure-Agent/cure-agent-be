import { Module } from '@nestjs/common';
import { PatientController } from './controller/patient.controller';
import { PatientRepository } from './repository/patient.repository';
import { PatientSnapshotService } from './service/patient-snapshot.service';
import { PatientService } from './service/patient.service';

@Module({
  controllers: [PatientController],
  providers: [PatientService, PatientSnapshotService, PatientRepository],
  exports: [PatientService, PatientSnapshotService],
})
export class PatientModule {}
