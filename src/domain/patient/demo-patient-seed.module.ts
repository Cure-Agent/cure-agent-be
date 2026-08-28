import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { demoSeedConfig } from '../../global/config/demo-seed.config';
import { DemoPatientSeeder } from './service/demo-patient-seeder.service';

/**
 * 데모 환자 시딩만 담는 모듈 — **컨트롤러가 없다** (docs/specs/41).
 *
 * PatientModule을 AuthModule이 import하면 `PatientController`가 그 하위로 스캔돼 생성되는
 * OpenAPI의 path 순서가 통째로 바뀐다. 컨트롤러 없는 모듈은 계약 파일을 건드리지 않는다.
 */
@Module({
  imports: [ConfigModule.forFeature(demoSeedConfig)],
  providers: [DemoPatientSeeder],
  exports: [DemoPatientSeeder],
})
export class DemoPatientSeedModule {}
