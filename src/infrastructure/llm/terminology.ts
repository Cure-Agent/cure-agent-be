/**
 * 한·영 용어집 (docs/specs/42).
 *
 * **답변 생성 프롬프트와 청크 번역 잡이 같은 목록을 읽는다.** 답변이 `pharmacopuncture`라 쓰고
 * 인용 번역이 `medicinal acupuncture`라 쓰면 독자는 「근거가 답을 지지하지 않는다」고 읽는다 —
 * 검증 UI에서는 오역보다 치명적이다. 왕복 번역 실측에서 실제로 관측된 이동이 근거다
 * (유침 → 「침을 두는 시간」, 취혈 원칙 → 혈위 선정 원칙).
 *
 * 코퍼스와 달리 **유한하고 저자가 우리**라 소스에 둔다 (스펙 판단표).
 *
 * **스텁** — 목록은 구현 단계에서 채운다.
 */

export interface TermPair {
  ko: string;
  en: string;
}

export const TERMBASE: readonly TermPair[] = [];
