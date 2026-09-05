/**
 * 질의·어휘 공용 토크나이저 (docs/specs/45).
 *
 * **질의와 어휘가 한 함수를 쓴다.** 갈리면 조회가 전부 미등재로 떨어져 개선이 통째로 사라진다.
 * 어휘 쪽은 조사 절단 **전** raw 어절을 담고 질의 쪽은 조사를 떼는데, 이는 같은 규칙의 두
 * 단계이지 다른 규칙이 아니다 — `환자` ⊂ `환자에게`가 성립해야 부분문자열 확장이 원래
 * `ILIKE` 의미와 맞는다.
 *
 * 형태소 분석기를 쓰지 않는다 — 격조사 절단만으로 충분함이 평가셋 185문항에서 실측됐고,
 * 사전 의존성은 인제스트·질의 양쪽에 배포 부담을 만든다.
 */

/** 질의 토큰 — 격조사 절단 후 2자 미만은 버린다. 등장 순서·중복 제거. */
export function tokenize(_text: string): string[] {
  throw new Error('not implemented');
}

/** 어휘 항 — 조사를 떼지 않은 raw 어절. 2자 미만 어절은 넣지 않는다. */
export function eojeolsOf(_text: string): string[] {
  throw new Error('not implemented');
}
