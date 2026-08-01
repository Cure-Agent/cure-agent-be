/**
 * groundedness 심판 포트 (docs/specs/30).
 *
 * 외부 유료 API라 **fake 치환 없이는 수용 기준을 동결할 수 없다**(architecture.md §3 기준) —
 * 리랭커(docs/specs/29)와 같은 판단이다.
 */

export const GROUNDEDNESS_JUDGE = Symbol('GROUNDEDNESS_JUDGE');

/** 심판에게 보이는 근거 — LlmEvidenceContext와 구조는 같지만 평가 도메인이 인프라에 의존하지 않는다 */
export interface JudgedEvidence {
  marker: number;
  content: string;
  guidelineTitle: string;
}

export interface JudgeInput {
  question: string;
  evidence: JudgedEvidence[];
  answer: string;
}

/**
 * 주장 단위 채점 결과.
 *
 * **세 축을 분리하는 이유**(docs/specs/30): miscited는 마커가 달려 검증된 것처럼 보이는
 * 인용 사기라 안전 최우선이고, unsupported는 할루시네이션 축이며, 면책·한계 고지는
 * 결함이 아니라 qa-v3 규칙 3·4의 준수다(루브릭이 비주장으로 제외한다).
 */
export interface GroundednessJudgement {
  claims: number;
  supported: number;
  miscited: number;
  unsupported: number;
  /** 리포트가 실을 무근거 주장 원문 (최대 2개) */
  unsupportedExamples: string[];
  /** 근거가 부족한데 답변이 그 사실을 밝혔는가 — qa-v3 규칙 3 준수 여부 */
  insufficiencyDisclosed: boolean;
  verdict: GroundednessVerdict;
}

export type GroundednessVerdict = 'grounded' | 'partial' | 'ungrounded';

export interface GroundednessJudge {
  /** GenerationRun과 나란히 비교하기 위한 심판 식별자 — 리포트에 실린다 */
  readonly model: string;
  judge(input: JudgeInput): Promise<GroundednessJudgement>;
}
