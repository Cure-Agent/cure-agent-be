/**
 * 참고안 구조화 포트 (docs/specs/33).
 *
 * QA 답변 생성(`LlmProvider`)과 분리한 이유는 리랭커(docs/specs/29)와 같다 — 그 계약은 근거 인용
 * 스트리밍 전용이고, 구조화는 **이미 완료된 답변**을 입력으로 받는 비스트리밍 단발 호출이다.
 * 외부 유료 API라 fake 치환 없이는 e2e 동결이 성립하지 않는다 (architecture.md §3 포트 기준).
 */

export const GUIDANCE_STRUCTURER = Symbol('GUIDANCE_STRUCTURER');

/** 구조화가 딛을 수 있는 **환자 다리** — 값이 채워진 스냅샷 임상 필드만 실린다 (§4.5) */
export interface GuidanceProfileField {
  /** missingInformation과 동일 어휘의 필드명 — patientFactors가 쓸 수 있는 값의 전부 */
  field: string;
  value: string;
}

/** 구조화가 딛을 수 있는 **근거 다리** — 답변이 실제 인용한 청크의 원문(quote 발췌가 아니다) */
export interface GuidanceEvidenceContext {
  marker: number;
  content: string;
  guidelineTitle: string;
  sectionPath: string[];
}

export interface GuidanceStructureInput {
  answerText: string;
  evidence: GuidanceEvidenceContext[];
  profileFields: GuidanceProfileField[];
}

export type GuidanceStructureRequest = GuidanceStructureInput & { signal?: AbortSignal };

/**
 * 프로바이더가 반환한 항목 — **아직 검증 전이다.**
 * 두 다리(markers·patientFactors)와 applicability의 통과·폐기는 도메인 검증기가 가른다.
 * 그래서 applicability가 여기서는 좁은 유니온이 아니라 string이다.
 */
export interface StructuredConsideration {
  title: string;
  rationale: string;
  applicability: string;
  markers: number[];
  patientFactors: string[];
}

export interface GuidanceStructureResult {
  considerations: StructuredConsideration[];
}

export interface GuidanceStructurer {
  /** composerVersion·관측에 기록되는 식별자 */
  readonly model: string;
  /**
   * 킬스위치 표식 (docs/specs/33 기준 8) — true면 스트림이 호출 자체를 생략하고
   * 결정적 조립을 유지한다. fake·실물은 이 필드를 두지 않는다(선택 멤버).
   */
  readonly disabled?: boolean;
  /** 실패는 예외로 던진다 — 호출측이 결정적 조립으로 폴백한다 (docs/specs/33) */
  structure(request: GuidanceStructureRequest): Promise<GuidanceStructureResult>;
}
