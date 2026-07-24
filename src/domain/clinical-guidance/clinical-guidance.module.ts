import { Module } from '@nestjs/common';
import { ClinicalGuidanceService } from './service/clinical-guidance.service';

@Module({
  providers: [ClinicalGuidanceService],
  exports: [ClinicalGuidanceService],
})
export class ClinicalGuidanceModule {}
