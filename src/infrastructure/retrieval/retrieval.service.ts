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
import { ConfigType } from '@nestjs/config';
import { retrievalConfig } from '../../global/config/retrieval.config';
import { TransactionManager } from '../../global/database/transaction-manager';
import { MetricsService } from '../../global/observability/metrics/metrics.service';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../embedding/embedding-provider.port';

/** 계측용 경과 시간 — hrtime은 시스템 시계 변경에 영향받지 않는다 */
function elapsedSeconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
}

export const RETRIEVAL_TOP_K = 5;

/**
 * RRF 상수 (docs/specs/31). 융합 점수는 arm마다 `1/(RRF_K + 순위)`의 합이다 —
 * 순위만 쓰므로 코사인 거리와 trigram 유사도처럼 **척도가 다른 두 점수를 정규화 없이 합칠 수 있다.**
 * 60은 실측에 쓴 값이며 튜닝은 spec 31 Out of scope다.
 */
const RRF_K = 60;

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
  /**
   * 코사인 거리 (0에 가까울수록 유사). 지금은 정렬에만 쓰고 버리던 값을 노출한다 —
   * 거리 임계값을 데이터로 정하려면 분포를 재야 하기 때문이다 (docs/specs/27).
   */
  distance: number;
}

/**
 * 하이브리드 검색 결과 (docs/specs/31) — 융합 순서로 정렬된다.
 *
 * arm별 순위를 부기하는 이유는 **평가와 운영이 같은 코드를 타게** 하기 위해서다:
 * 벡터 원 지표(§27·§28의 비교 축)와 키워드 arm 기여도를 한 번의 검색으로 함께 잰다.
 */
export interface HybridEvidence extends RetrievedEvidence {
  /** 벡터 arm에서의 순위(1-based). 그 arm에 없으면 null */
  vectorRank: number | null;
  /** 키워드 arm에서의 순위(1-based). 그 arm에 없으면 null */
  keywordRank: number | null;
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
    private readonly metrics: MetricsService,
    @Inject(retrievalConfig.KEY)
    private readonly config: ConfigType<typeof retrievalConfig>,
  ) {}

  /**
   * GenerationRun 재현성 기록용 (architecture.md §5.7, §9).
   * 검색 결과는 임베딩 모델에 종속되므로 모델을 포함하고(docs/specs/14), 기권 게이트가 정책의
   * 일부가 되면서 **실사용 컷 값**도 포함한다(docs/specs/28) — env로 컷을 바꾼 운영 기록도
   * 이 문자열에서 구분된다.
   */
  get policyVersion(): string {
    return `cosine-top5-cut${this.config.distanceCutoff}-v2/${this.embeddingProvider.model}`;
  }

  /** 기권 게이트가 소비하는 임계값 — 판정 자체는 대화 정책이라 conversation-stream이 소유한다 */
  get distanceCutoff(): number {
    return this.config.distanceCutoff;
  }

  /** 리랭크 설정 노출 (docs/specs/29) — distanceCutoff와 같은 이유로 단일 접근 경로를 유지한다 */
  get rerankEnabled(): boolean {
    return this.config.rerankEnabled;
  }

  get rerankCandidates(): number {
    return this.config.rerankCandidates;
  }

  get rerankScoreCutoff(): number {
    return this.config.rerankScoreCutoff;
  }

  /** 하이브리드 검색 설정 노출 (docs/specs/31) — 위와 같은 이유로 단일 접근 경로를 유지한다 */
  get hybridEnabled(): boolean {
    return this.config.hybridEnabled;
  }

  /**
   * 하이브리드로 답한 GenerationRun의 정책 버전 (docs/specs/31 기준 6).
   * 리랭크 적용 여부가 문자열로 갈린다 — 폴백·비활성은 rerankerModel을 주지 않는다.
   */
  hybridPolicyVersion(rerankerModel?: string): string {
    const base = `hybrid-rrf${RRF_K}-top${this.config.rerankCandidates}x2`;
    const rerank = rerankerModel
      ? `-rerank-${rerankerModel}-cut${this.config.distanceCutoff}` +
        `-score${this.config.rerankScoreCutoff}`
      : `-cut${this.config.distanceCutoff}`;
    return `${base}${rerank}-v4/${this.embeddingProvider.model}`;
  }

  /**
   * 리랭크로 답한 GenerationRun의 정책 버전 (docs/specs/29 기준 7).
   * 폴백·비활성은 기존 policyVersion(v2)을 그대로 기록한다 — GenerationRun에서
   * 「이 답변이 실제로 리랭크를 탔는가」가 문자열로 구분된다.
   */
  rerankedPolicyVersion(rerankerModel: string): string {
    return (
      `cosine-top${this.config.rerankCandidates}-rerank-${rerankerModel}` +
      `-cut${this.config.distanceCutoff}-score${this.config.rerankScoreCutoff}` +
      `-v3/${this.embeddingProvider.model}`
    );
  }

  /**
   * 현재 좌표계로 **검색 가능한** 청크 수 (docs/specs/27).
   * 기준선을 나란히 비교할 때 코퍼스 규모가 같은지 확인하는 값이다 — 지표만 보면
   * 코퍼스가 늘어 어려워진 것과 검색이 나빠진 것을 구분할 수 없다.
   */
  async countSearchableChunks(): Promise<number> {
    const [row] = await this.txManager.conn
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(evidenceChunks)
      .innerJoin(guidelineVersions, eq(evidenceChunks.guidelineVersionId, guidelineVersions.id))
      .where(
        and(
          eq(evidenceChunks.embeddingModel, this.embeddingProvider.model),
          eq(guidelineVersions.status, 'ACTIVE'),
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * `topK`는 **진단용 확장 지점**이다 (docs/specs/27). 운영 검색은 기본값(top-5)을 쓰고,
   * 평가만 K를 넓혀 「후보군엔 있는데 순서가 나쁜가(리랭커) / 애초에 못 찾는가(하이브리드)」를
   * 가른다. 정책 버전은 그대로 top5다 — K를 넓힌 조회는 운영 정책이 아니라 진단 수단이다.
   */
  async search(
    query: string,
    filters?: RetrievalFilters,
    topK: number = RETRIEVAL_TOP_K,
  ): Promise<RetrievedEvidence[]> {
    const embedStartedAt = process.hrtime.bigint();
    const [embedding] = await this.embeddingProvider.embed([query]);
    this.metrics.recordRetrievalStage('embed', elapsedSeconds(embedStartedAt));

    const conditions = [
      // 좌표계가 다른 벡터는 코사인 거리가 무의미하다 — 같은 모델로 만든 청크만 본다 (docs/specs/14).
      // 모델을 바꾸면 재인제스트 전까지 근거 0건(abstain)이 되며, 이것이 조용한 오답보다 안전하다.
      eq(evidenceChunks.embeddingModel, this.embeddingProvider.model),
      // 폐기된 판본·회차는 새 답변에 인용되지 않는다 (docs/specs/21).
      // 과거 인용은 message_citations로 계속 조회되므로 역사적 정확성은 유지된다.
      eq(guidelineVersions.status, 'ACTIVE'),
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

    // 정렬에만 쓰던 거리를 SELECT에도 싣는다 — 같은 식이므로 추가 연산 비용은 없다
    const distance = cosineDistance(evidenceChunks.embedding, embedding);

    const searchStartedAt = process.hrtime.bigint();
    const rows = await this.txManager.conn
      .select({
        chunk: evidenceChunks,
        section: guidelineSections,
        version: guidelineVersions,
        guideline: guidelines,
        distance: sql<number>`${distance}`.mapWith(Number),
      })
      .from(evidenceChunks)
      .innerJoin(guidelineSections, eq(evidenceChunks.sectionId, guidelineSections.id))
      .innerJoin(guidelineVersions, eq(evidenceChunks.guidelineVersionId, guidelineVersions.id))
      .innerJoin(guidelines, eq(guidelineVersions.guidelineId, guidelines.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(distance))
      .limit(topK);
    this.metrics.recordRetrievalStage('vector_search', elapsedSeconds(searchStartedAt));

    // 0건도 기록한다 — 그 0이 abstain의 원인이고, 급등은 인제스트 사고의 조기 경보다
    this.metrics.recordRetrievedChunks(rows.length);
    if (rows.length > 0) this.metrics.recordTop1Distance(rows[0].distance);

    return rows;
  }

  /**
   * 하이브리드 검색 (docs/specs/31) — 벡터 arm과 키워드 arm의 **합집합**을 RRF로 융합한다.
   *
   * 절단하지 않는 이유는 실측이다: RRF top-30으로 자르면 한쪽 arm에서만 깊게 잡히는 정답이
   * 잘려 후보 커버리지가 0.978에 머물지만, 합집합 전체(≤2K)는 1.000이다.
   *
   * `armK`는 §27과 같은 **진단용 확장 지점**이다 — 운영은 기본값(`rerankCandidates`)을 쓴다.
   */
  async searchHybrid(
    query: string,
    filters?: RetrievalFilters,
    armK: number = this.config.rerankCandidates,
  ): Promise<HybridEvidence[]> {
    void query;
    void filters;
    void armK;
    return Promise.resolve([]);
  }
}
