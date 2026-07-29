import { Module } from '@nestjs/common';
import { PdfTextExtractor } from '../../infrastructure/document/pdf-text.extractor';
import { EmbeddingModule } from '../../infrastructure/embedding/embedding.module';
import { GuidelineSourceModule } from '../../infrastructure/guideline-source/guideline-source.module';
import { AdminGuard } from '../../global/security/admin.guard';
import { ClinicianModule } from '../clinician/clinician.module';
import {
  AdminGuidelineController,
  AdminGuidelineVersionController,
} from './controller/admin-guideline.controller';
import { EvidenceController } from './controller/evidence.controller';
import { GuidelineController } from './controller/guideline.controller';
import { GuidelineRepository } from './repository/guideline.repository';
import { SourceDocumentRepository } from './repository/source-document.repository';
import { GuidelineAcquisitionService } from './service/guideline-acquisition.service';
import { GuidelineAdminService } from './service/guideline-admin.service';
import { GuidelineIngestService } from './service/guideline-ingest.service';
import { GuidelineParseService } from './service/guideline-parse.service';
import { GuidelineService } from './service/guideline.service';

@Module({
  // ClinicianModule은 AdminGuard의 역할 조회를 위해 필요하다 (docs/specs/21)
  imports: [EmbeddingModule, GuidelineSourceModule, ClinicianModule],
  controllers: [
    GuidelineController,
    EvidenceController,
    AdminGuidelineController,
    AdminGuidelineVersionController,
  ],
  providers: [
    GuidelineService,
    GuidelineIngestService,
    GuidelineRepository,
    // 지침 원본 수집 (docs/specs/18) — CLI와 관리 파이프라인이 함께 소비한다
    GuidelineAcquisitionService,
    SourceDocumentRepository,
    // 지침 PDF 파싱 (docs/specs/19)
    GuidelineParseService,
    // 코퍼스 관리 API (docs/specs/21)
    GuidelineAdminService,
    PdfTextExtractor,
    AdminGuard,
  ],
  exports: [GuidelineIngestService, GuidelineAcquisitionService, GuidelineParseService],
})
export class GuidelineModule {}
