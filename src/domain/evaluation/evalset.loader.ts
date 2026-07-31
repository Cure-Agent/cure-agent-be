/**
 * 평가셋 로더 (docs/specs/27 수용 기준 3).
 *
 * `approved`만 평가에 포함하고, 스키마 위반은 조용히 거르지 않고 **에러로 거부**한다 —
 * 라벨이 청크를 특정하지 못하는 문항이 섞이면 기준선이 낙관 오염된다.
 */
import { EvalSetItem } from './evalset.types';

/** 평가셋이 계약을 어겼을 때 — 로더는 이걸 던지고 호출측(CLI)이 비영 종료한다 */
export class EvalSetSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalSetSchemaError';
  }
}

/**
 * 원시 JSON을 검증해 **평가 대상 문항만** 돌려준다.
 *
 * TODO(docs/specs/27 기준 3): approved 필터 + 스키마 검증.
 * 안정 키 결손 = guidelineTitle·publisher 누락 또는 recommendationNumber·sectionPath 둘 다 없음.
 */
export function loadEvalSet(_raw: unknown): EvalSetItem[] {
  throw new Error('TODO: docs/specs/27 기준 3 미구현');
}
