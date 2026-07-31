/**
 * 지침 원본 수집 포트 (docs/specs/18).
 *
 * 프로세스 밖 경계(NCKM HTTP)라 포트로 감싼다 — 수용 기준 2·3·4·7이 응답 형태를 제어해야
 * 검증 가능하기 때문이다 (§3 포트 기준).
 *
 * **이 포트는 판정하지 않는다.** 받아온 것을 그대로 넘기고, FETCHED/SKIPPED/FAILED 판정과
 * 매직바이트 검사는 서비스가 한다. 포트가 판정하면 fake도 판정을 흉내내야 해서
 * 수용 기준 2·3·4가 자기 자신을 검증하게 된다.
 */

export const GUIDELINE_SOURCE = Symbol('GUIDELINE_SOURCE');

/** 목록 1건 — 다운로드에 필요한 식별자와 DB에 기록할 메타 */
export interface SourceListItem {
  /** NCKM guide_idx */
  externalId: string;
  title: string;
  /** 목록의 agency */
  publisher: string;
  /** "2024-07"처럼 일자가 없을 수 있어 원문 문자열을 그대로 전달한다 */
  releaseDate: string | null;
  /**
   * 원본 목록이 준 레코드 수정 시각 — 개정 감지의 축이다 (docs/specs/26).
   * `releaseDate`와 같이 **원문 문자열을 그대로** 전달한다(로케일 의존 형식이라 파싱하지 않는다).
   *
   * 목록이 주지 않으면 없다 — 소비 지점이 `?? null`로 정규화하며, 값이 없는 문서는
   * 「모르면 받아본다」로 후보가 된다(기준 5). optional인 덕에 이 필드를 모르는 기존 fake도
   * 그대로 컴파일되고, 그 fake들은 자동으로 「모름」 경로를 탄다.
   */
  sourceModifiedAt?: string | null;
  /** view.do — 인용 시 노출할 원문 링크 */
  sourceUrl: string;
  /**
   * 목록의 guide_file. 저장 파일명으로 쓴다 — content-disposition은 EUC-KR로 깨져 오기 때문이다.
   * 목록에 없으면 호출측이 externalId 기반 이름으로 대체한다.
   */
  fileName?: string;
}

/** 다운로드 결과 — 판정 전의 raw 응답이다 */
export interface SourceDownload {
  body: Buffer;
  contentType: string;
}

export interface ListOptions {
  /** 앞에서부터 N건으로 제한 */
  limit?: number;
  /** 지정한 externalId만 남긴다 */
  externalIds?: string[];
}

export interface GuidelineSourcePort {
  /** source_documents.source_system에 기록되는 출처 식별자 */
  readonly system: string;
  listGuidelines(options?: ListOptions): Promise<SourceListItem[]>;
  /** 본문을 받지 못하면 GuidelineSourceError를 던진다 (서비스가 FAILED로 기록) */
  download(item: SourceListItem): Promise<SourceDownload>;
}

export class GuidelineSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuidelineSourceError';
  }
}
