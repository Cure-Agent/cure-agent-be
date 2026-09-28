import { Module } from '@nestjs/common';
import { PatientController } from './controller/patient.controller';
import { PatientRepository } from './repository/patient.repository';
import { PatientSnapshotService } from './service/patient-snapshot.service';
import { PatientService } from './service/patient.service';

@Module({
  controllers: [PatientController],
  providers: [PatientService, PatientSnapshotService, PatientRepository],
  // 대화 스트림이 자동 제목의 케이스 라벨을 읽는다(docs/specs/56) — 복호화가 필요 없는 스코프 조회다
  exports: [PatientService, PatientSnapshotService, PatientRepository],
})
export class PatientModule {}
