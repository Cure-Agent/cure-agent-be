import { Module } from '@nestjs/common';
import { PatientSnapshotService } from './service/patient-snapshot.service';

@Module({
  providers: [PatientSnapshotService],
  exports: [PatientSnapshotService],
})
export class PatientModule {}
