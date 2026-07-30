import {
  ExpiredListEntry,
  expiryMismatches,
  SourceDocumentIdentity,
} from './known-source-defects';

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
  /**
   * 본문 sha256 (docs/specs/25 기준 3). version만으로는 같은 release_date 재발행에서
   * 판정이 만료되지 않아, 대상 아님으로 확정한 근거가 바뀐 뒤에도 계속 건너뛴다.
   */
  fileHash: string;
  reason: string;
}

/** NCKM 항목의 공통 축 — 15건이 모두 같은 원본 시스템이다 */
const nckm = (
  externalId: string,
  version: string,
  fileHash: string,
  reason: string,
): NotIngestTarget => ({
  sourceSystem: 'NCKM',
  externalId,
  version,
  fileHash,
  reason,
});

/**
 * 확정 목록 (docs/specs/24 실측 조사 B·C표, 2026-07-30).
 *
 * **145 현훈·219 골다공증은 여기 없다** — 마커 표기만 다른 현역 표준지침이고 이 스텝이 파서를
 * 넓혀 적재한다. 두 문서를 목록에 넣는 것이 이슈 #106이 저지른 실수였다.
 */
export const NOT_INGEST_TARGETS: NotIngestTarget[] = [
  // ── B. 등급 좌표계가 다르고 후속 표준판이 이미 적재됨 ──────────────
  nckm(
    '95',
    '2013-08',
    '1ed630c0e334af03654251ada6f7ecf5c267fe4d1dd63720655000aee606f619',
    '경항통 침구 임상진료지침 — 문서 끝 「권고사항」 요약표에 권고 5건이 있으나 권고수준이 ' +
      'Brosseau 체계(A/B/C+/C/D+/D/D-)로 현행 GRADE와 코드 문자가 같고 뜻이 다르다. ' +
      '후속 148 경항통 한의표준임상진료지침(2021-03)이 적재돼 있다.',
  ),
  nckm(
    '96',
    '2013-08',
    'b89d491d748ee79def6cfa523e97ce9a0c72e0e695113cf716412f6f8073094e',
    '슬통 침구 임상진료지침 — 권고 11건, 등급 체계는 95와 같다. 후속 153 퇴행성 슬관절염' +
      '(2020-01)·332 류마티스 관절염(2024-07)·174 슬관절전치환술후(2021-06)가 적재돼 있다.',
  ),
  nckm(
    '97',
    '2013-08',
    '030d430a66ae9f41a85095f382a872820ca60c78a3235569b8d56c6a7855f12e',
    '요통 침구 임상진료지침 — 권고 10건, 등급 체계는 95와 같다. 후속 149 만성 요통 증후군' +
      '(2020-01)·151 요추 추간판 탈출증(2020-01)·170 퇴행성 요추척추관협착증(2021-06)이 적재돼 있다.',
  ),
  nckm(
    '98',
    '2013-06',
    '4d9ce91d2941ec6ccdba689d3e985eff5108d4f0653dbafcb0572ff9bba2d12f',
    '화병 한의표준임상진료지침 — 권고를 ①②③ 인라인 `(근거수준 D, 권고등급 I)` 형태로 밝히고 ' +
      '체계가 UMHS(근거수준 A~D는 연구설계, 권고등급 Ⅰ~Ⅲ는 로마숫자)다. ' +
      '후속 147 화병 한의표준임상진료지침(2021-05)이 적재돼 있다.',
  ),
  nckm(
    '124',
    '2020-03',
    '0e49a8f15030e02f44a5be7cc62cd3fbc72c6ca8cb3d1ce4c37866b10adc5e63',
    '코로나19 한의진료 지침 — 등급이 GPP로 현행 어휘와 호환되지만 2020년 3월 급성기 대응 ' +
      '권고다. 6년이 지나 상황과 치료 권고가 모두 바뀌었고, 낡은 급성기 권고가 현재 임상 판단에 ' +
      '섞이는 편이 코퍼스에 코로나 권고가 없는 것보다 해롭다.',
  ),
  nckm(
    '125',
    '2020-03',
    '95202730d24bb13b368ab44f8dabd5d56d6858a12d601135d1a445437a325874',
    '코로나19 한의진료 권고안 — 124의 권고표를 「표 3.」으로 재수록한 문서다. 적재하면 중복이다.',
  ),
  // ── C. 지침이 아니거나 파싱 불가 ────────────────────────────────
  nckm(
    '90',
    '2007-10',
    '54640adf80353894680d542c3072b7a3e5546b4e85e144e3df4efc823790781f',
    '경추부 질환 임상진료지침 — 등급 체계 자체가 없다. 치료법 설문조사 순위표' +
      '(`1순위치료법 2순위치료법`)와 해부·진단 서술이다. 후속 148 경항통(2021-03)이 적재돼 있다.',
  ),
  nckm(
    '91',
    '2007-10',
    '4505589c560ba0873566b3c42f4fec803bcb8d095621164b125fb032cdda2b13',
    '요추부 질환 임상진료지침 — 90과 같은 배치·같은 구성이다. 후속 149·151·170이 적재돼 있다.',
  ),
  nckm(
    '92',
    '2009-01',
    '28ba7b640ed3a4b68a81ff197f8c4adfd0e2c41eef34a28fc5e01d7f4e8c313b',
    '한의사를 위한 신종인플루엔자 A(H1N1) 예방 및 환자 관리 지침 — 등급 없음. ' +
      '감염병 역학·증상·예방접종 정보 문서다.',
  ),
  nckm(
    '93',
    '2010-05',
    '5a7ea127b6a87e723fc30f849bd5f751fb6b2a970d833c353fbb01916cefcfa5',
    '금연침 시술 및 환자 상담 가이드 라인 — 등급 없음. ' +
      '후속 299 금연 한의표준임상진료지침(2023)이 적재돼 있다.',
  ),
  nckm(
    '94',
    '2010-12',
    '12f0a678626b7e476800d59d91343861cba28a490db48114bc1d0204c28411d0',
    '난임 한방임상진료지침 — **스캔 이미지 PDF로 추출 텍스트가 0자다**(144쪽 전부). ' +
      'OCR 없이는 파싱이 불가능하고, 후속 321 여성난임 한의표준임상진료지침(2024-04)이 적재돼 있다.',
  ),
  nckm(
    '185',
    '2022-02',
    'c5e0b91436a859ea0162be9e34b579e586564118a2a0c4b01537e16bf1bd4f09',
    '재난트라우마의 한의사 진료 매뉴얼 — 등급 없음. 진료 흐름도·단계별 프로토콜 문서다.',
  ),
  nckm(
    '239',
    '2022-10',
    '013f9abde5863af740e801f90bed6d82740170ceb50dfdff4ca99287d886b0fb',
    '치매의 행동심리증상(BPSD) 관리 근거기반 정보교류 매뉴얼(안) — 일본·중국·국내 **타 지침의 ' +
      '권고를 인용·비교하는 문서**로 한 문서에 등급 체계가 4종 이상 혼재한다(`(2C)`·' +
      '`권고등급 A/근거수준 1`·`권고등급 B/근거수준 Low`). 인용 대상인 169 치매 한의표준임상' +
      '진료지침(2021-06)이 이미 적재돼 있다.',
  ),
  nckm(
    '314',
    '2024-02',
    'c95770984a21c0d2458dd7713f0c47d4ae89460915dd062eddd4c2c0f28d6925',
    '코로나바이러스 감염증-19 한의진료 매뉴얼 — 등급 없음. 진료 매뉴얼이다.',
  ),
  nckm(
    '668',
    '2022-06',
    '1183573ad6bdf20356ed997b0cf577f36a25af0d9c868bdf1b22bad800d36dba',
    'Manual for Developing Evidence-based CPG of Korean Medicine (Ver. 2.0) — **지침 작성법 ' +
      '매뉴얼**이다. 권고문 작성 예시로 `R1. Herbal medicine treatment may be …`를 23건 들기 ' +
      '때문에, 마커 문법이 넓어진 뒤에는 이 목록이 반드시 이 문서를 막아야 한다.',
  ),
];

/**
 * 문서가 대상 아님으로 확정된 항목을 찾는다. 셋 중 하나라도 다르면 다른 문서다.
 *
 * 순수 함수로 두어 파이프라인과 `verify:templates`가 **같은 판정**을 쓰게 한다 —
 * 갈라지면 CLI가 통과시킨 문서가 운영에서 실패한다.
 */
export function findNotIngestTarget(
  identity: SourceDocumentIdentity,
  targets: NotIngestTarget[] = NOT_INGEST_TARGETS,
): NotIngestTarget | undefined {
  return targets.find(
    (target) =>
      target.sourceSystem === identity.sourceSystem &&
      target.externalId === identity.externalId &&
      // version·fileHash가 어긋나면 만료다 — 다시 사람의 판단을 받아야 한다 (docs/specs/25 기준 4)
      target.version === identity.version &&
      target.fileHash === identity.fileHash,
  );
}

/**
 * 문서는 맞는데 축이 어긋나 적용되지 않은 대상 아님 항목을 고른다 (docs/specs/25 기준 1~3).
 *
 * 목록은 문서당 최대 1건이므로 단수로 돌려준다 — 결함 면제는 한 문서에 진단별로 여럿일 수 있어
 * 배열이다(`findExpiredSourceDefects`).
 */
export function findExpiredNotIngestTarget(
  identity: SourceDocumentIdentity,
  targets: NotIngestTarget[] = NOT_INGEST_TARGETS,
): ExpiredListEntry<NotIngestTarget> | undefined {
  for (const entry of targets) {
    const mismatches = expiryMismatches(entry, identity);
    if (mismatches.length > 0) return { entry, mismatches };
  }
  return undefined;
}
