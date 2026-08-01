/**
 * groundedness 리포트 렌더링 (docs/specs/30).
 * 소비처는 화면이 아니라 `docs/rag-eval/`에 커밋되는 파일이다 — 측정이 쌓이면
 * PR 본문만으로는 비교가 흩어진다(2026-08-02 관행).
 */
import { GroundednessReport } from './groundedness-eval.service';

/**
 * TODO(docs/specs/30 기준 4·5·6): verdict 분포·주장 단위 3축·기계 검사·flagged·실패 문항을
 * 담은 마크다운을 만든다.
 */
export function renderGroundednessReport(_report: GroundednessReport): string {
  throw new Error('TODO: docs/specs/30 미구현');
}
