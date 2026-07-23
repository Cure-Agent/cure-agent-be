import { Inject, Injectable } from '@nestjs/common';
import { and, asc, cosineDistance, eq, inArray, sql } from 'drizzle-orm';
import {
  EvidenceChunkRow,
  GuidelineRow,
  GuidelineSectionRow,
  GuidelineVersionRow,
  evidenceChunks,
  guidelineSections,
  guidelineVersions,
  guidelines,
} from '../../domain/guideline/persistence/guideline.schema';
import { TransactionManager } from '../../global/database/transaction-manager';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../embedding/embedding-provider.port';

/** 검색 정책 버전 — GenerationRun 재현성 기록용 (architecture.md §5.7, §9) */
export const RETRIEVAL_POLICY_VERSION = 'cosine-exact-top5-v1';
export const RETRIEVAL_TOP_K = 5;

export interface RetrievalFilters {
  guidelineIds?: string[];
  recommendationGrades?: string[];
  evidenceLevels?: string[];
}

export interface RetrievedEvidence {
  chunk: EvidenceChunkRow;
  section: GuidelineSectionRow;
  version: GuidelineVersionRow;
  guideline: GuidelineRow;
}

/**
 * pgvector cosine exact search (architecture.md §12 — 인덱스는 측정 후).
 * 질문을 임베딩해 evidence_chunks에서 top-K를 조회한다.
 */
@Injectable()
export class RetrievalService {
  constructor(
    private readonly txManager: TransactionManager,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  async search(query: string, filters?: RetrievalFilters): Promise<RetrievedEvidence[]> {
    const [embedding] = await this.embeddingProvider.embed([query]);

    const conditions = [
      filters?.guidelineIds?.length
        ? inArray(guidelineVersions.guidelineId, filters.guidelineIds)
        : undefined,
      filters?.recommendationGrades?.length
        ? inArray(
            sql`${evidenceChunks.recommendationGrade}->>'code'`,
            filters.recommendationGrades,
          )
        : undefined,
      filters?.evidenceLevels?.length
        ? inArray(sql`${evidenceChunks.evidenceLevel}->>'code'`, filters.evidenceLevels)
        : undefined,
    ].filter((c) => c !== undefined);

    return this.txManager.conn
      .select({
        chunk: evidenceChunks,
        section: guidelineSections,
        version: guidelineVersions,
        guideline: guidelines,
      })
      .from(evidenceChunks)
      .innerJoin(guidelineSections, eq(evidenceChunks.sectionId, guidelineSections.id))
      .innerJoin(guidelineVersions, eq(evidenceChunks.guidelineVersionId, guidelineVersions.id))
      .innerJoin(guidelines, eq(guidelineVersions.guidelineId, guidelines.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(cosineDistance(evidenceChunks.embedding, embedding)))
      .limit(RETRIEVAL_TOP_K);
  }
}
