import { ChunkDiagnostics } from '../../../infrastructure/document/guideline-chunker';

/**
 * 알려진 **원문 결함** 면제 (docs/specs/23 기준 9~13).
 *
 * 파서가 고칠 수 없는 결함이 원문에 있다 — 예: ADHD 지침(306)은 서로 다른 두 권고에 같은
 * `【R20】`을 달았다. 이때 **가드를 넓히지 않고 예외를 좁힌다.** 검증 술어를 완화하면 그 술어가
 * 앞으로 들어올 모든 문서에 적용되기 때문이다. 특히 「내용이 다르면 통과」는 성립하지 않는다 —
 * 결과요약표의 재인용도 본문 권고문과 텍스트가 다르므로 진짜 재인용 오탐까지 통과시킨다.
 *
 * **DB가 아니라 코드로 관리한다.** 면제의 조건 중 하나가 「사람이 추가하고 리뷰에 보인다」인데
 * DB 행은 PR 리뷰에 나타나지 않는다.
 *
 * 순수 함수로 두어 파이프라인(`GuidelineParseService`)과 `verify:templates`가 **같은 판정을**
 * 쓰게 한다. 인프라(`template-verification.ts`)가 도메인을 import하지 않도록, 둘을 엮는 것은
 * 스크립트 쪽이다.
 */
export interface KnownSourceDefect {
  sourceSystem: string;
  externalId: string;
  /**
   * `source_documents.release_date`에서 온 문서 버전. **면제의 만료 장치다** —
   * 개정판이 오면 값이 달라져 면제가 적용되지 않고, 결함이 고쳐졌는지 다시 판정된다.
   */
  version: string;
  diagnostic: 'missing' | 'duplicated' | 'gradeMissing';
  /** 면제 대상 권고 번호. 여기 없는 번호는 여전히 실패한다 — 면제는 번호 단위로 좁다 */
  numbers: string[];
  reason: string;
}

/** 면제 대상 문서를 식별하는 축 */
export interface SourceDocumentIdentity {
  sourceSystem: string;
  externalId: string;
  version: string;
}

export const KNOWN_SOURCE_DEFECTS: KnownSourceDefect[] = [
  {
    sourceSystem: 'NCKM',
    externalId: '306',
    version: '2026-06',
    diagnostic: 'duplicated',
    numbers: ['R20'],
    reason:
      '원문이 서로 다른 두 권고에 같은 【R20】을 달았다 — p.263 침 치료(C/Very low)와 ' +
      'p.273 침+양약 병용(C/Low). 파서가 고칠 수 있는 결함이 아니고, 이 한 건 때문에 ' +
      '나머지 권고를 통째로 잃지 않기 위해 면제한다. 두 블록은 모두 적재된다.',
  },
];

/**
 * 진단에서 면제된 번호를 덜어낸 사본과, 실제로 면제된 항목을 함께 돌려준다.
 * 면제 사실을 호출자가 로그·보고에 남길 수 있어야 하므로(기준 12) 조용히 지우지 않는다.
 */
export function applyKnownSourceDefects(
  diagnostics: ChunkDiagnostics,
  identity: SourceDocumentIdentity,
  defects: KnownSourceDefect[] = KNOWN_SOURCE_DEFECTS,
): { diagnostics: ChunkDiagnostics; applied: KnownSourceDefect[] } {
  // 셋 중 하나라도 다르면 다른 문서다. version이 어긋나면 개정판이므로 면제가 만료된 것이다
  const applied = defects.filter(
    (defect) =>
      defect.sourceSystem === identity.sourceSystem &&
      defect.externalId === identity.externalId &&
      defect.version === identity.version,
  );

  const waived = (kind: KnownSourceDefect['diagnostic']): Set<string> =>
    new Set(applied.filter((d) => d.diagnostic === kind).flatMap((d) => d.numbers));

  const without = (numbers: string[], kind: KnownSourceDefect['diagnostic']): string[] => {
    const skip = waived(kind);
    return numbers.filter((number) => !skip.has(number));
  };

  return {
    // 입력을 변형하지 않는다 — 호출자가 원본 진단을 그대로 로그·보고에 쓸 수 있어야 한다
    diagnostics: {
      uniqueNumbers: [...diagnostics.uniqueNumbers],
      missing: without(diagnostics.missing, 'missing'),
      duplicated: without(diagnostics.duplicated, 'duplicated'),
      gradeMissing: without(diagnostics.gradeMissing, 'gradeMissing'),
      unknownEvidenceLevels: diagnostics.unknownEvidenceLevels.map((entry) => ({ ...entry })),
    },
    applied,
  };
}
