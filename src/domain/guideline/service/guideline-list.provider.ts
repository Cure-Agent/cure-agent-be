import { Injectable } from '@nestjs/common';
import {
  KNOWN_SOURCE_DEFECTS,
  KnownSourceDefect,
} from './known-source-defects';
import { NOT_INGEST_TARGETS, NotIngestTarget } from './not-ingest-targets';

/**
 * 면제·제외 목록의 **조회 주입점** (docs/specs/25 기준 15).
 *
 * §23·§24의 목록은 커밋된 상수이고 판정 함수는 순수 함수다 — 그 설계는 유지된다. 이 클래스는
 * 목록을 **어디서 읽을지만** 감싼다.
 *
 * 왜 필요한가: §25가 `fileHash`를 판정 축에 넣으면서 §24의 e2e가 성립하지 않게 됐다. 그 e2e는
 * 합성 본문(`%PDF-1.7\nDOC:90…`)으로 커밋된 항목에 매칭해 SKIPPED 경로를 검증하는데,
 * **합성 본문의 sha256이 커밋된 실물 해시와 같을 수 없다.** §3의 포트 기준
 * (*"이걸 감싸지 않으면 수용 기준을 테스트로 동결할 수 없는가"*)을 정확히 충족하는 자리다.
 *
 * 인터페이스를 만들지 않는다 — 구현이 하나뿐이고 e2e는 `overrideProvider`로 치환하면 충분하다
 * (§3, `PdfTextExtractor`와 같은 판단).
 *
 * `verify:templates`는 이 주입점을 쓰지 않고 순수 함수를 직접 호출한다 — CLI에는 DI가 없고,
 * **실물 PDF의 실제 해시로 커밋된 상수를 검증하는 것이 그쪽의 목적**이기 때문이다.
 * e2e는 메커니즘을, CLI는 실제 항목을 덮는 분업이다.
 */
@Injectable()
export class GuidelineListProvider {
  knownSourceDefects(): KnownSourceDefect[] {
    return KNOWN_SOURCE_DEFECTS;
  }

  notIngestTargets(): NotIngestTarget[] {
    return NOT_INGEST_TARGETS;
  }
}
