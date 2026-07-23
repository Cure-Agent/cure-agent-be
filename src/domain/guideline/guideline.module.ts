import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../../infrastructure/embedding/embedding.module';
import { EvidenceController } from './controller/evidence.controller';
import { GuidelineController } from './controller/guideline.controller';
import { GuidelineRepository } from './repository/guideline.repository';
import { GuidelineIngestService } from './service/guideline-ingest.service';
import { GuidelineService } from './service/guideline.service';

@Module({
  imports: [EmbeddingModule],
  controllers: [GuidelineController, EvidenceController],
  providers: [GuidelineService, GuidelineIngestService, GuidelineRepository],
  exports: [GuidelineIngestService],
})
export class GuidelineModule {}
