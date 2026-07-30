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
  /**
   * 본문 sha256 (docs/specs/25 기준 3). **version만으로는 만료가 새는 자리를 막는다** —
   * NCKM이 같은 release_date로 파일만 교체하면(정오표 재발행) `source_documents`는 해시
   * 유니크라 새 행이 생기는데도 version이 같아 면제가 계속 붙었다. 원문이 결함을 고쳤어도
   * 면제하고, 새 결함이 생겨도 면제가 덮는 조용한 오적용이다.
   */
  fileHash: string;
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
  /** §18이 그 다운로드에 기록한 본문 sha256 (docs/specs/25 기준 11) */
  fileHash: string;
}

/** 항목이 어긋난 축 하나 (docs/specs/25 기준 2·5) */
export interface ExpiryMismatch {
  axis: 'version' | 'fileHash';
  /** 목록에 커밋된 값 */
  recorded: string;
  /** 지금 문서의 값 */
  current: string;
}

/**
 * **만료 후보** — 문서(`sourceSystem`+`externalId`)는 맞는데 축이 어긋나 판정이 적용되지 않은 항목.
 *
 * 조용한 「못 찾음」과 구분하려고 따로 돌려준다. 이것이 없으면 실패 진단이 거짓 방향을 가리킨다 —
 * 대상 아님 경로는 "목록에도 없습니다"(실제로는 있다), 면제 경로는 번호 중복만 열거해
 * 면제 만료인지 파서 회귀인지 구분할 수 없다.
 */
export interface ExpiredListEntry<T> {
  entry: T;
  mismatches: ExpiryMismatch[];
}

export const KNOWN_SOURCE_DEFECTS: KnownSourceDefect[] = [
  {
    sourceSystem: 'NCKM',
    externalId: '306',
    version: '2026-06',
    fileHash: '',
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
  // 네 축이 모두 같아야 적용된다 — version이나 fileHash가 어긋나면 만료다 (docs/specs/25 기준 4)
  const applied = defects.filter(
    (defect) =>
      defect.sourceSystem === identity.sourceSystem &&
      defect.externalId === identity.externalId &&
      defect.version === identity.version &&
      defect.fileHash === identity.fileHash,
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
      // 비도출은 면제 대상이 아니다 — 원문 결함이 아니라 원문의 의도이므로 그대로 나른다
      notDerived: [...diagnostics.notDerived],
    },
    applied,
  };
}

/**
 * 문서는 맞는데 축이 어긋나 적용되지 않은 면제 항목을 고른다 (docs/specs/25 기준 1~3).
 *
 * 구현에서 채운다 — 스텁은 빈 목록이다.
 */
export function findExpiredSourceDefects(
  _identity: SourceDocumentIdentity,
  _defects: KnownSourceDefect[] = KNOWN_SOURCE_DEFECTS,
): ExpiredListEntry<KnownSourceDefect>[] {
  return [];
}
