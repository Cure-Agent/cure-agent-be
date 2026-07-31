/**
 * RAG 평가셋 타입 (docs/specs/27).
 *
 * 라벨은 chunk ID가 아니라 **안정 키**다 — 재인제스트·재파싱은 chunk ID를 바꾸므로
 * (docs/specs/21 revision) 지침의 유니크 키 + 권고번호/섹션경로로 기록하고 평가 시점에 조인한다.
 */

/** 답해야 하는 질문인가, 기권해야 하는 질문인가 */
export type EvalKind = 'answerable' | 'abstain';

/**
 * 검수 상태. `approved`만 평가에 들어간다 — 역생성 질문은 원본 청크와 어휘를 공유해
 * 검색이 실제보다 쉬워지는 낙관 편향이 있으므로, 사람 검수가 관문이다.
 */
export type EvalStatus = 'candidate' | 'approved' | 'rejected';

/** 문항의 출처 — 역생성분과 직접 작성분을 구분해 편향을 추적한다 */
export type EvalOrigin = 'reverse-generated' | 'manual';

/**
 * 기대 근거의 안정 키.
 * `(guidelineTitle, publisher)`는 uq_guidelines_title_publisher에 대응하고,
 * 그 안에서 `recommendationNumber`(권고 청크) 또는 `sectionPath`(비권고)가 청크를 좁힌다.
 */
export interface ExpectedEvidence {
  guidelineTitle: string;
  publisher: string;
  recommendationNumber?: string;
  sectionPath?: string[];
}

export interface EvalSetItem {
  id: string;
  kind: EvalKind;
  question: string;
  /** abstain 문항은 빈 배열이다 */
  expectedEvidence: ExpectedEvidence[];
  status: EvalStatus;
  origin: EvalOrigin;
}
