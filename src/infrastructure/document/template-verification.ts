/**
 * 실물 회귀 대조 (docs/specs/20 수용 기준 13).
 *
 * PDF 원문을 커밋하지 않고도 31건을 회귀 그물로 유지하기 위해, **건수만** 담은 기대치와 대조한다.
 * 판정 기준은 "전건 성공"이 아니라 **"알려진 상태와 일치"** — 그래야 회귀(되던 문서가 깨짐)와
 * 개선(안 되던 문서가 됨)이 둘 다 드러난다.
 */
import { ChunkDiagnostics } from './guideline-chunker';

/**
 * `NOT_TARGET`은 **인제스트 대상이 아니라고 확정된 문서**다 (docs/specs/24 기준 15~17).
 *
 * 이전에는 90·97이 `{uniqueNumbers: 0, recommendations: 0, status: "OK"}`로 적혀 있었다 —
 * 「대상 아님」이 「0건 성공」으로 위장되어, 파서가 망가져 0건을 내도 통과했다. 두 상태를 가르면
 * `NOT_TARGET` 문서에서 권고가 나오는 순간 불일치로 드러난다(145·219가 정확히 그 경우였다).
 */
export type TemplateStatus = 'OK' | 'PARTIAL' | 'NOT_TARGET';

export interface TemplateExpectation {
  uniqueNumbers: number;
  recommendations: number;
  status: TemplateStatus;
  /** status가 PARTIAL일 때 아직 파싱되지 않는 권고 번호 */
  unparsed?: string[];
  /**
   * 번호는 발급됐으나 원문이 권고를 내지 않은 번호 (docs/specs/24 기준 5).
   *
   * `unknownEvidenceLevels`와 같은 성격이다 — **`status`를 바꾸지 않고** 알려진 집합으로만 고정한다.
   * 개별 1건은 조치할 것이 없지만 집계가 늘면 원문 성격 변화·배제 드리프트의 신호다.
   */
  notDerived?: string[];
  /**
   * 등급 문자는 읽었으나 근거수준이 정규형에 없던 원문 표기 (docs/specs/23 기준 8).
   *
   * **`status`에는 넣지 않는다** — 미상 근거수준은 파싱 실패가 아니다. 알려진 1건이 있는 문서도
   * `OK`이며, 여기 고정된 집합이 달라질 때만 불일치로 드러난다. 개별 1건은 조치할 것이 없지만
   * 집계가 늘면 어휘 노후·추출 드리프트의 신호이므로, 그 **변화**를 잡는 것이 목적이다.
   */
  unknownEvidenceLevels?: { recommendationNumber: string; raw: string }[];
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
  /** 인제스트 대상 아님으로 확정된 문서 수 (docs/specs/24) */
  notTarget: number;
  mismatches: TemplateMismatch[];
  /** 기대치에 없는 문서 / 문서가 없는 기대치 */
  unexpected: string[];
  missingDocuments: string[];
}

/**
 * 문서별 실제 산출을 기대치와 대조한다. 부수효과 없는 순수 함수다.
 *
 * @param notIngestTargetIds 코드의 대상 아님 목록에 있는 문서 id — 기대치의 `NOT_TARGET`과
 *   **어긋나면 불일치로 보고한다** (docs/specs/24 기준 17). 도메인 모듈을 여기서 import하지 않고
 *   id만 받아, 인프라 → 도메인 의존이 생기지 않게 한다(§23이 면제 목록을 엮은 방식과 같다).
 */
export function compareToExpectations(
  actual: Record<string, TemplateActual>,
  expected: Record<string, TemplateExpectation>,
  notIngestTargetIds: string[] = [],
): VerificationReport {
  const report: VerificationReport = {
    checked: 0,
    ok: 0,
    partial: 0,
    notTarget: 0,
    mismatches: [],
    unexpected: [],
    missingDocuments: [],
  };
  const listed = new Set(notIngestTargetIds);

  for (const [documentId, observed] of Object.entries(actual)) {
    const target = expected[documentId];
    if (!target) {
      report.unexpected.push(documentId);
      continue;
    }
    report.checked += 1;
    if (target.status === 'NOT_TARGET') report.notTarget += 1;
    else if (target.status === 'OK') report.ok += 1;
    else report.partial += 1;

    for (const reason of describeMismatches(observed, target)) {
      report.mismatches.push({ documentId, reason });
    }
    // 기대치와 코드의 대상 아님 목록이 갈라지면 CLI가 통과시킨 문서가 운영에서 실패한다 (기준 17)
    if (target.status === 'NOT_TARGET' && !listed.has(documentId)) {
      report.mismatches.push({
        documentId,
        reason: '기대치는 NOT_TARGET인데 코드의 대상 아님 목록에 없다',
      });
    }
    if (target.status !== 'NOT_TARGET' && listed.has(documentId)) {
      report.mismatches.push({
        documentId,
        reason: `코드의 대상 아님 목록에 있는데 기대치 상태가 ${target.status}다`,
      });
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

  // 대상 아님으로 확정된 문서에서 권고가 나오면 **판정이 틀렸다는 신호**다 (기준 16).
  // 145·219가 정확히 그 경우였고, 그때 기대치는 `{0, 0, "OK"}`라 아무것도 드러내지 못했다.
  if (target.status === 'NOT_TARGET') {
    if (observed.recommendations > 0 || uniqueNumbers > 0) {
      reasons.push(
        `대상 아님으로 확정된 문서에서 권고가 나왔다 — 고유 ${uniqueNumbers} / 권고문 ${observed.recommendations}`,
      );
    }
    return [...reasons, ...describeNotDerivedMismatch(observed, target)];
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

  const unknown = describeUnknownEvidence(observed.diagnostics.unknownEvidenceLevels);
  const targetUnknown = describeUnknownEvidence(target.unknownEvidenceLevels ?? []);
  if (!sameSet(unknown, targetUnknown)) {
    reasons.push(`미상 근거수준 [${targetUnknown.join(', ')}] → [${unknown.join(', ')}]`);
  }
  return [...reasons, ...describeNotDerivedMismatch(observed, target)];
}

/**
 * 비도출 번호의 **집합 변화**를 잡는다 (docs/specs/24 기준 5).
 *
 * `unknownEvidenceLevels`와 같은 성격이라 `status`를 바꾸지 않는다 — 개별 1건은 조치할 것이
 * 없지만, 1건이 40건이 되면 원문 성격의 변화나 배제 규칙의 드리프트 신호다.
 */
function describeNotDerivedMismatch(
  observed: TemplateActual,
  target: TemplateExpectation,
): string[] {
  const actual = observed.diagnostics.notDerived;
  const expected = target.notDerived ?? [];
  if (sameSet(actual, expected)) return [];
  return [`권고 비도출 [${expected.join(', ')}] → [${actual.join(', ')}]`];
}

/** 집합 비교용 정규화 — `R5-1=Vey Low` 형태로 눌러 순서에 의존하지 않게 한다 */
function describeUnknownEvidence(
  entries: { recommendationNumber: string; raw: string }[],
): string[] {
  return entries.map((entry) => `${entry.recommendationNumber}=${entry.raw}`);
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
