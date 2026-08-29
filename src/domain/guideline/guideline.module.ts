import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { guidelineScanConfig } from '../../global/config/guideline-scan.config';
import { PdfTextExtractor } from '../../infrastructure/document/pdf-text.extractor';
import { EmbeddingModule } from '../../infrastructure/embedding/embedding.module';
import { GuidelineSourceModule } from '../../infrastructure/guideline-source/guideline-source.module';
import { AdminGuard } from '../../global/security/admin.guard';
import { ClinicianModule } from '../clinician/clinician.module';
import {
  AdminGuidelineJobController,
  AdminPipelineRunController,
} from './controller/admin-guideline-job.controller';
import {
  AdminGuidelineController,
  AdminGuidelineVersionController,
} from './controller/admin-guideline.controller';
import { EvidenceController } from './controller/evidence.controller';
import { GuidelineController } from './controller/guideline.controller';
import { GuidelineJobRepository } from './repository/guideline-job.repository';
import { GuidelineRepository } from './repository/guideline.repository';
import { PipelineRunRepository } from './repository/pipeline-run.repository';
import { SourceDocumentRepository } from './repository/source-document.repository';
import { GuidelineAcquisitionService } from './service/guideline-acquisition.service';
import { GuidelineAdminService } from './service/guideline-admin.service';
import { GuidelineIngestService } from './service/guideline-ingest.service';
import { GuidelineJobRecoveryService } from './service/guideline-job-recovery.service';
import { GuidelineJobRunner } from './service/guideline-job.runner';
import { GuidelineJobService } from './service/guideline-job.service';
import { GuidelinePipelineService } from './service/guideline-pipeline.service';
import { GuidelineRevisionScanService } from './service/guideline-revision-scan.service';
import { GuidelineParseService } from './service/guideline-parse.service';
import { GuidelineListProvider } from './service/guideline-list.provider';
import { GuidelineJobEventBus } from './sse/guideline-job-event.bus';
import { GuidelineService } from './service/guideline.service';
import { ChunkTranslatorService } from './service/chunk-translator.service';
import { LlmModule } from '../../infrastructure/llm/llm.module';

@Module({
  // ClinicianModule은 AdminGuard의 역할 조회를 위해 필요하다 (docs/specs/21)
  imports: [
    EmbeddingModule,
    GuidelineSourceModule,
    ClinicianModule,
    // 청크 번역 잡이 TRANSLATOR를 쓴다 (docs/specs/42). 컨트롤러가 없는 모듈이라
    // OpenAPI path 순서에 영향이 없다 (§41 판단표의 AuthModule 사례와 다르다)
    LlmModule,
    // 개정 감지 스캔 설정 (docs/specs/26)
    ConfigModule.forFeature(guidelineScanConfig),
  ],
  controllers: [
    GuidelineController,
    EvidenceController,
    AdminGuidelineController,
    AdminGuidelineVersionController,
    // 전건 파이프라인 잡 (docs/specs/22)
    AdminGuidelineJobController,
    AdminPipelineRunController,
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
    GuidelineListProvider,
    // 코퍼스 관리 API (docs/specs/21)
    GuidelineAdminService,
    // 전건 파이프라인 잡 (docs/specs/22)
    GuidelineJobService,
    GuidelineJobRunner,
    GuidelinePipelineService,
    GuidelineJobRecoveryService,
    // 개정 감지 스케줄러 (docs/specs/26) — 크론 트리거는 infrastructure/scheduler가 부른다
    GuidelineRevisionScanService,
    GuidelineJobEventBus,
    GuidelineJobRepository,
    PipelineRunRepository,
    PdfTextExtractor,
    AdminGuard,
    // 청크 번역 멱등 잡 (docs/specs/42) — CLI가 소비한다
    ChunkTranslatorService,
  ],
  exports: [
    GuidelineIngestService,
    GuidelineAcquisitionService,
    GuidelineParseService,
    // 크론 트리거가 부른다 (docs/specs/26)
    GuidelineRevisionScanService,
    // pnpm translate:chunks가 부른다 (docs/specs/42)
    ChunkTranslatorService,
  ],
})
export class GuidelineModule {}
