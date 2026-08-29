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
 * **범위는 데모 6주제가 밟는 어휘다.** 표준 영문 용어집(WHO 전통의학 용어 등)을 그대로 옮긴
 * 것이 아니므로, 전량 번역으로 넓힐 때 출처를 확인해 재작성한다 — 스펙 Out of scope의
 * 「번역 품질의 자동 관측」과 같은 시점이다.
 */

export interface TermPair {
  ko: string;
  en: string;
}

export const TERMBASE: readonly TermPair[] = [
  // 치료 수단 — 왕복 실측에서 갈라진 축
  { ko: '침 치료', en: 'acupuncture treatment' },
  { ko: '전침', en: 'electroacupuncture' },
  { ko: '약침', en: 'pharmacopuncture' },
  { ko: '봉약침', en: 'bee venom pharmacopuncture' },
  { ko: '한약', en: 'herbal medicine' },
  { ko: '뜸', en: 'moxibustion' },
  { ko: '부항', en: 'cupping' },
  { ko: '추나', en: 'Chuna manual therapy' },
  // 시술 파라미터 — 「유침」이 왕복에서 소실됐다
  { ko: '유침 시간', en: 'needle retention time' },
  { ko: '취혈', en: 'acupoint selection' },
  { ko: '혈자리', en: 'acupoint' },
  { ko: '변증', en: 'pattern identification' },
  // 지침 구조 — 인용 카드에 그대로 노출된다
  { ko: '권고', en: 'recommendation' },
  { ko: '권고등급', en: 'recommendation grade' },
  { ko: '근거수준', en: 'level of evidence' },
  { ko: '임상적 고려사항', en: 'clinical considerations' },
  { ko: '한의표준임상진료지침', en: 'Korean Medicine Clinical Practice Guideline' },
];

/** 프롬프트에 실을 형태 — 생성과 번역이 같은 문자열을 본다 */
export function renderTermbase(): string {
  return TERMBASE.map((pair) => `${pair.ko} = ${pair.en}`).join(' · ');
}
