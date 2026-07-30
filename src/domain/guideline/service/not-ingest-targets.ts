import { SourceDocumentIdentity } from './known-source-defects';

/**
 * **인제스트 대상 아님** 확정 목록 (docs/specs/24 기준 10~14).
 *
 * §20이 "인제스트 대상으로 삼을지부터 판단이 필요하다"며 미룬 판단이 이 목록이다.
 * 이슈 #106은 그 판단을 `containsRecommendationMarker() === false`라는 **추론**에 맡겼고,
 * 그 추론이 145 현훈·219 골다공증에서 틀렸다 — 마커 표기가 다를 뿐인 현역 표준지침 2건이
 * 「대상 아님」으로 조용히 건너뛰어졌다. §20 기준 3이 막으려던 그 통과가 그 자리에서 일어났다.
 *
 * 그래서 **마커 부재는 더 이상 SKIPPED의 근거가 아니다.** 마커를 못 찾은 문서는 이 목록에 있으면
 * `SKIPPED`, 없으면 `FAILED`다. 신규 매뉴얼류가 등록되면 잡이 실패하고 사람이 판단해야 하는데,
 * 그 운영 부담이 이 설계의 목적이다 — **판정을 조용히 자동화하는 것과 진짜 지침을 잃는 것을
 * 교환할 수 없다.**
 *
 * §23의 원문 결함 면제(`known-source-defects.ts`)와 **같은 계층·같은 규약**이다: 커밋된 코드이고
 * (DB 행은 PR 리뷰에 나타나지 않는다), 항목이 `version`을 가져 개정판에 만료되며, 적용되면 로그와
 * `verify:templates` 보고에 남는다. 두 목록을 합치지 않는 이유는 판정 시점과 결과가 다르기 때문이다 —
 * 결함 면제는 「파싱하고 가드만 면제」, 대상 아님은 「파싱하지 않는다」.
 */
export interface NotIngestTarget {
  sourceSystem: string;
  externalId: string;
  /**
   * `source_documents.release_date`에서 온 문서 버전. **판정의 만료 장치다** —
   * 개정판이 오면 값이 달라져 판정이 적용되지 않고 `FAILED`가 되어, 사람이 다시 판단한다.
   */
  version: string;
  reason: string;
}

/** 확정 목록 — 실제 항목은 구현에서 채운다 (docs/specs/24 실측 조사 B·C표) */
export const NOT_INGEST_TARGETS: NotIngestTarget[] = [];

/**
 * 문서가 대상 아님으로 확정된 항목을 찾는다. 셋 중 하나라도 다르면 다른 문서다.
 *
 * 순수 함수로 두어 파이프라인과 `verify:templates`가 **같은 판정**을 쓰게 한다 —
 * 갈라지면 CLI가 통과시킨 문서가 운영에서 실패한다.
 */
export function findNotIngestTarget(
  _identity: SourceDocumentIdentity,
  _targets: NotIngestTarget[] = NOT_INGEST_TARGETS,
): NotIngestTarget | undefined {
  return undefined;
}
