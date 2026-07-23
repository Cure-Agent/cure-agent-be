import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { TransactionManager } from '../../../global/database/transaction-manager';
import {
  EMBEDDING_PROVIDER,
  EmbeddingProvider,
} from '../../../infrastructure/embedding/embedding-provider.port';
import { GuidelineRepository } from '../repository/guideline.repository';
import { GuidelineIngestInput, GuidelineIngestResult } from './guideline-ingest.input';

interface PreparedChunk {
  sectionIndex: number;
  content: string;
  contentHash: string;
  order: number;
  recommendationNumber: string | null;
  recommendationGrade: { system: string; code: string; label: string } | null;
  evidenceLevel: { system: string; code: string; label: string } | null;
  pageStart: number | null;
  pageEnd: number | null;
}

/**
 * 구조화 JSON 인제스트 (docs/specs/05).
 * - guideline은 (title, publisher) upsert, 동일 버전 재인제스트는 skip (멱등)
 * - 임베딩은 트랜잭션 밖에서 일괄 계산 후 저장
 * - 실행마다 IngestionRun 기록 (실패 시 FAILED + 사유)
 */
@Injectable()
export class GuidelineIngestService {
  constructor(
    private readonly txManager: TransactionManager,
    private readonly repository: GuidelineRepository,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  async ingest(input: GuidelineIngestInput): Promise<GuidelineIngestResult> {
    this.validate(input);
    const inputHash = sha256(JSON.stringify(input));

    try {
      return await this.write(input, inputHash);
    } catch (error) {
      await this.repository.insertIngestionRun({
        id: ulid(),
        status: 'FAILED',
        inputHash,
        error: String(error).slice(0, 2000),
      });
      throw error;
    }
  }

  private async write(
    input: GuidelineIngestInput,
    inputHash: string,
  ): Promise<GuidelineIngestResult> {
    const existingGuideline = await this.repository.findByTitlePublisher(
      input.title,
      input.publisher,
    );
    const guidelineId = existingGuideline?.id ?? ulid();

    // 동일 버전 재인제스트 → 콘텐츠 변경 없이 skip (수용 기준 2)
    if (existingGuideline) {
      const existingVersion = await this.repository.findVersion(guidelineId, input.version);
      if (existingVersion) {
        const skippedChunks = input.sections.reduce((sum, s) => sum + s.chunks.length, 0);
        const stats = { sections: 0, chunks: 0, skippedChunks };
        await this.repository.insertIngestionRun({
          id: ulid(),
          status: 'SUCCEEDED',
          inputHash,
          guidelineId,
          guidelineVersionId: existingVersion.id,
          stats,
        });
        return { guidelineId, guidelineVersionId: existingVersion.id, created: false, stats };
      }
    }

    // 버전 내 중복 콘텐츠 dedupe 후 임베딩 일괄 계산 (트랜잭션 밖)
    const prepared: PreparedChunk[] = [];
    const seenHashes = new Set<string>();
    let skippedChunks = 0;
    input.sections.forEach((section, sectionIndex) => {
      section.chunks.forEach((chunk, chunkIndex) => {
        const contentHash = sha256(chunk.content);
        if (seenHashes.has(contentHash)) {
          skippedChunks += 1;
          return;
        }
        seenHashes.add(contentHash);
        prepared.push({
          sectionIndex,
          content: chunk.content,
          contentHash,
          order: chunkIndex,
          recommendationNumber: chunk.recommendationNumber ?? null,
          recommendationGrade: chunk.recommendationGrade ?? null,
          evidenceLevel: chunk.evidenceLevel ?? null,
          pageStart: chunk.pageStart ?? null,
          pageEnd: chunk.pageEnd ?? null,
        });
      });
    });
    const embeddings = await this.embeddingProvider.embed(prepared.map((c) => c.content));

    const guidelineVersionId = ulid();
    const stats = { sections: input.sections.length, chunks: prepared.length, skippedChunks };

    await this.txManager.run(async () => {
      if (!existingGuideline) {
        await this.repository.insertGuideline({
          id: guidelineId,
          title: input.title,
          publisher: input.publisher,
        });
      }
      await this.repository.insertVersion({
        id: guidelineVersionId,
        guidelineId,
        version: input.version,
        publishedAt: new Date(input.publishedAt),
        sourceUrl: input.sourceUrl,
        contentHash: inputHash,
      });

      const sectionIds: string[] = [];
      for (const [index, section] of input.sections.entries()) {
        const sectionId = ulid();
        sectionIds[index] = sectionId;
        await this.repository.insertSection({
          id: sectionId,
          guidelineVersionId,
          title: section.title,
          path: section.path,
          order: section.order,
        });
      }

      await this.repository.insertChunks(
        prepared.map((chunk, index) => ({
          id: ulid(),
          sectionId: sectionIds[chunk.sectionIndex],
          guidelineVersionId,
          content: chunk.content,
          embedding: embeddings[index],
          recommendationNumber: chunk.recommendationNumber,
          recommendationGrade: chunk.recommendationGrade,
          evidenceLevel: chunk.evidenceLevel,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          order: chunk.order,
          contentHash: chunk.contentHash,
        })),
      );

      await this.repository.insertIngestionRun({
        id: ulid(),
        status: 'SUCCEEDED',
        inputHash,
        guidelineId,
        guidelineVersionId,
        stats,
      });
    });

    return { guidelineId, guidelineVersionId, created: true, stats };
  }

  private validate(input: GuidelineIngestInput): void {
    const problems: string[] = [];
    for (const field of ['title', 'publisher', 'version', 'sourceUrl'] as const) {
      if (typeof input[field] !== 'string' || input[field].length === 0) {
        problems.push(`${field} 누락`);
      }
    }
    if (Number.isNaN(Date.parse(input.publishedAt))) problems.push('publishedAt 형식 오류');
    if (!Array.isArray(input.sections) || input.sections.length === 0) {
      problems.push('sections 비어 있음');
    } else {
      input.sections.forEach((section, i) => {
        if (!Array.isArray(section.path) || section.path.length === 0)
          problems.push(`sections[${i}].path 누락`);
        if (!section.title) problems.push(`sections[${i}].title 누락`);
        (section.chunks ?? []).forEach((chunk, j) => {
          if (!chunk.content) problems.push(`sections[${i}].chunks[${j}].content 누락`);
        });
      });
    }
    if (problems.length > 0) {
      throw new ServiceException('BAD_REQUEST', { reason: 'INVALID_INGEST_INPUT', problems });
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
