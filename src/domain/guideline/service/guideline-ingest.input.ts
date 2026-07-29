/** 인제스트 입력 계약 (docs/specs/05 §범위) — PDF 파싱은 P1, 구조화 JSON만 받는다. */

export interface IngestRating {
  system: string; // GRADE 등
  code: string;
  label: string;
}

export interface IngestChunk {
  content: string;
  recommendationNumber?: string;
  recommendationGrade?: IngestRating;
  evidenceLevel?: IngestRating;
  pageStart?: number;
  pageEnd?: number;
}

export interface IngestSection {
  path: string[];
  title: string;
  order: number;
  chunks: IngestChunk[];
}

export interface GuidelineIngestInput {
  title: string;
  publisher: string;
  version: string;
  publishedAt: string; // ISO 날짜
  sourceUrl: string;
  sections: IngestSection[];
}

export interface GuidelineIngestResult {
  guidelineId: string;
  guidelineVersionId: string;
  /** 이번 실행에서 새 revision을 만들었는지 (동일 내용이면 false = skip) */
  created: boolean;
  /** 원문 판본 */
  version: string;
  /** 같은 판본을 다시 파싱한 처리 회차 (docs/specs/21) */
  revision: number;
  status: 'ACTIVE' | 'SUPERSEDED';
  stats: { sections: number; chunks: number; skippedChunks: number };
}

// ── embed / persist 분리 (docs/specs/22) ───────────────
// 파이프라인이 phase=EMBED와 phase=INGEST를 따로 계측해야 해서 인제스트를 두 구간으로 쪼갠다.
// 아래 타입들은 그 경계에서 오가는 중간 산출이다.

/**
 * dedupe를 마친 청크 — 임베딩 입력 순서와 1:1로 대응한다.
 * `sectionIndex`는 입력 `sections` 배열에서의 위치다. persist가 섹션을 새로 만들면서
 * 발급한 id로 되짚어야 하므로 섹션 id 대신 인덱스를 들고 다닌다.
 */
export interface PreparedIngestChunk {
  sectionIndex: number;
  content: string;
  contentHash: string;
  order: number;
  recommendationNumber: string | null;
  recommendationGrade: IngestRating | null;
  evidenceLevel: IngestRating | null;
  pageStart: number | null;
  pageEnd: number | null;
}

/**
 * embed 단계의 산출. 재적재 skip과 실제 적재를 판별 유니온으로 가른다 —
 * skip 경로는 임베딩을 **호출하지 않으므로**(docs/specs/22: created=false 실행에는
 * `stages.embed` 키 자체가 없다) 벡터도 모델도 낼 수 없다. 두 경우를 한 타입에 뭉개면
 * 호출측이 `vectors: 0`을 「0건 임베딩」과 구분하지 못한다.
 */
export type GuidelineEmbedOutcome = GuidelineEmbedSkip | GuidelineEmbedWrite;

export interface GuidelineEmbedSkip {
  kind: 'skip';
  /** 쓸 것이 없어 결과가 이미 확정돼 있다 — persist는 이걸 그대로 돌려준다 */
  result: GuidelineIngestResult;
}

export interface GuidelineEmbedWrite {
  kind: 'write';
  input: GuidelineIngestInput;
  inputHash: string;
  guidelineId: string;
  /** guideline 행이 이미 있는지 — persist가 insert 여부를 여기서 정한다 */
  guidelineExists: boolean;
  revision: number;
  chunks: PreparedIngestChunk[];
  /** `chunks`와 같은 순서의 벡터 */
  embeddings: number[][];
  /** 버전 내 중복이라 임베딩하지 않고 버린 청크 수 */
  skippedChunks: number;
  /** stages.embed 계측값 — 실제로 임베딩을 호출한 청크 수와 그때의 모델 */
  embed: { vectors: number; model: string };
}
