/**
 * 기준선 리포트 렌더링 (docs/specs/27 수용 기준 5).
 *
 * 마크다운인 이유: 이 산출물의 소비처는 화면이 아니라 **PR의 전후 비교표**다 —
 * diff가 남고 리뷰에 그대로 붙는다.
 */
import { RagEvalReport } from './rag-eval.service';

/**
 * TODO(docs/specs/27 기준 5): 지표 요약·실패 문항·kind별 거리 분포·retrievalPolicyVersion을
 * 담은 마크다운을 만든다.
 */
export function renderEvalReport(_report: RagEvalReport): string {
  throw new Error('TODO: docs/specs/27 기준 5 미구현');
}
