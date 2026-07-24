import { Module } from '@nestjs/common';
import { ClinicalGuidanceController } from './controller/clinical-guidance.controller';
import { ClinicalGuidanceRepository } from './repository/clinical-guidance.repository';
import { ClinicalGuidanceComposer } from './service/clinical-guidance-composer.service';
import { ClinicalGuidanceService } from './service/clinical-guidance.service';

@Module({
  controllers: [ClinicalGuidanceController],
  providers: [ClinicalGuidanceService, ClinicalGuidanceComposer, ClinicalGuidanceRepository],
  exports: [ClinicalGuidanceComposer],
})
export class ClinicalGuidanceModule {}
