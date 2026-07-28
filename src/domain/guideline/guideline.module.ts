import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../../infrastructure/embedding/embedding.module';
import { GuidelineSourceModule } from '../../infrastructure/guideline-source/guideline-source.module';
import { EvidenceController } from './controller/evidence.controller';
import { GuidelineController } from './controller/guideline.controller';
import { GuidelineRepository } from './repository/guideline.repository';
import { SourceDocumentRepository } from './repository/source-document.repository';
import { GuidelineAcquisitionService } from './service/guideline-acquisition.service';
import { GuidelineIngestService } from './service/guideline-ingest.service';
import { GuidelineService } from './service/guideline.service';

@Module({
  imports: [EmbeddingModule, GuidelineSourceModule],
  controllers: [GuidelineController, EvidenceController],
  providers: [
    GuidelineService,
    GuidelineIngestService,
    GuidelineRepository,
    // 지침 원본 수집 (docs/specs/18) — 엔드포인트 없이 CLI가 소비한다
    GuidelineAcquisitionService,
    SourceDocumentRepository,
  ],
  exports: [GuidelineIngestService, GuidelineAcquisitionService],
})
export class GuidelineModule {}
