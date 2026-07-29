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
