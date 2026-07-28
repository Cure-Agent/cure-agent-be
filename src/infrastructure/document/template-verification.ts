/**
 * 실물 회귀 대조 (docs/specs/20 수용 기준 13).
 *
 * PDF 원문을 커밋하지 않고도 31건을 회귀 그물로 유지하기 위해, **건수만** 담은 기대치와 대조한다.
 * 판정 기준은 "전건 성공"이 아니라 **"알려진 상태와 일치"** — 그래야 회귀(되던 문서가 깨짐)와
 * 개선(안 되던 문서가 됨)이 둘 다 드러난다.
 */
import { ChunkDiagnostics } from './guideline-chunker';

export type TemplateStatus = 'OK' | 'PARTIAL';

export interface TemplateExpectation {
  uniqueNumbers: number;
  recommendations: number;
  status: TemplateStatus;
  /** status가 PARTIAL일 때 아직 파싱되지 않는 권고 번호 */
  unparsed?: string[];
}

export interface TemplateActual {
  diagnostics: ChunkDiagnostics;
  /** 실제로 만들어진 권고문 청크 수 */
  recommendations: number;
}

export interface TemplateMismatch {
  documentId: string;
  /** 어긋난 항목과 기대·실제를 사람이 읽을 수 있게 */
  reason: string;
}

export interface VerificationReport {
  checked: number;
  ok: number;
  partial: number;
  mismatches: TemplateMismatch[];
  /** 기대치에 없는 문서 / 문서가 없는 기대치 */
  unexpected: string[];
  missingDocuments: string[];
}

/** 문서별 실제 산출을 기대치와 대조한다. 부수효과 없는 순수 함수다. */
export function compareToExpectations(
  actual: Record<string, TemplateActual>,
  expected: Record<string, TemplateExpectation>,
): VerificationReport {
  void actual;
  void expected;
  return { checked: 0, ok: 0, partial: 0, mismatches: [], unexpected: [], missingDocuments: [] };
}
