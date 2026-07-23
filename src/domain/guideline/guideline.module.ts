import { Module } from '@nestjs/common';
import { GuidelineIngestService } from './service/guideline-ingest.service';

@Module({
  providers: [GuidelineIngestService],
  exports: [GuidelineIngestService],
})
export class GuidelineModule {}
