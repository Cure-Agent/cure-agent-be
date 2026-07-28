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
  const report: VerificationReport = {
    checked: 0,
    ok: 0,
    partial: 0,
    mismatches: [],
    unexpected: [],
    missingDocuments: [],
  };

  for (const [documentId, observed] of Object.entries(actual)) {
    const target = expected[documentId];
    if (!target) {
      report.unexpected.push(documentId);
      continue;
    }
    report.checked += 1;
    if (target.status === 'OK') report.ok += 1;
    else report.partial += 1;

    for (const reason of describeMismatches(observed, target)) {
      report.mismatches.push({ documentId, reason });
    }
  }

  // 기대치에는 있는데 디렉토리에 없는 문서 — 받아둔 표본이 줄어든 것도 신호다
  for (const documentId of Object.keys(expected)) {
    if (!(documentId in actual)) report.missingDocuments.push(documentId);
  }
  return report;
}

function describeMismatches(
  observed: TemplateActual,
  target: TemplateExpectation,
): string[] {
  const reasons: string[] = [];
  const uniqueNumbers = observed.diagnostics.uniqueNumbers.length;
  if (uniqueNumbers !== target.uniqueNumbers) {
    reasons.push(`고유 권고 번호 ${target.uniqueNumbers} → ${uniqueNumbers}`);
  }
  if (observed.recommendations !== target.recommendations) {
    reasons.push(`권고문 청크 ${target.recommendations} → ${observed.recommendations}`);
  }

  const status: TemplateStatus = isFullyParsed(observed.diagnostics) ? 'OK' : 'PARTIAL';
  if (status !== target.status) {
    // 개선(PARTIAL → OK)도 불일치로 보고한다 — 기대치를 갱신해 이력에 남겨야 하기 때문이다
    reasons.push(`상태 ${target.status} → ${status}`);
  }
  const unparsed = unparsedNumbers(observed.diagnostics);
  if (!sameSet(unparsed, target.unparsed ?? [])) {
    reasons.push(`미파싱 번호 [${(target.unparsed ?? []).join(', ')}] → [${unparsed.join(', ')}]`);
  }
  return reasons;
}

function isFullyParsed(diagnostics: ChunkDiagnostics): boolean {
  return unparsedNumbers(diagnostics).length === 0;
}

function unparsedNumbers(diagnostics: ChunkDiagnostics): string[] {
  return [
    ...new Set([...diagnostics.missing, ...diagnostics.duplicated, ...diagnostics.gradeMissing]),
  ].sort();
}

function sameSet(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
