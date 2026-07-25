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

  /**
   * GenerationRun 기록용 — 검색 결과는 임베딩 모델에 종속되므로 정책 버전에 모델을 포함한다 (docs/specs/14).
   */
  get policyVersion(): string {
    return `${RETRIEVAL_POLICY_VERSION}/${this.embeddingProvider.model}`;
  }

  async search(query: string, filters?: RetrievalFilters): Promise<RetrievedEvidence[]> {
    const [embedding] = await this.embeddingProvider.embed([query]);

    const conditions = [
      // 좌표계가 다른 벡터는 코사인 거리가 무의미하다 — 같은 모델로 만든 청크만 본다 (docs/specs/14).
      // 모델을 바꾸면 재인제스트 전까지 근거 0건(abstain)이 되며, 이것이 조용한 오답보다 안전하다.
      eq(evidenceChunks.embeddingModel, this.embeddingProvider.model),
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
