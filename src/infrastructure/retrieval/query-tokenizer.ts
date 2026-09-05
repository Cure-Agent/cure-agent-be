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
 *
 * **규칙의 원천은 spec 45 본문이다.** 그 규칙으로 만든 토큰이 185문항에서 8.10배·R@30 0.973을
 * 낸 것이므로, 한 글자라도 다르면 그 실측이 성립하지 않는다.
 */

/** 어절 경계 — 질의 토큰과 코퍼스 어절이 **같은 문자 클래스**로 잘려야 항등성이 성립한다 */
const BOUNDARY = /[^0-9A-Za-z가-힣]+/;

/** 2자 미만은 변별력이 없다 — 질의 토큰에서도, 어휘 항에서도 버린다 */
const MIN_LENGTH = 2;

/**
 * 격조사 43개. **긴 것부터 검사해 하나만 뗀다** — 짧은 것을 먼저 보면 `에서는`이
 * `는` → `에서` 두 번 잘려 원형을 잃는다.
 */
const CASE_PARTICLES = [
  // 3자
  '에서는',
  '에게서',
  '으로서',
  '으로써',
  '이라도',
  '이라는',
  '에서도',
  '에게도',
  // 2자
  '에서',
  '에게',
  '께서',
  '으로',
  '이나',
  '라도',
  '부터',
  '까지',
  '보다',
  '처럼',
  '마다',
  '조차',
  '마저',
  '밖에',
  '이라',
  '라는',
  '라고',
  '와의',
  '과의',
  '에는',
  '로는',
  // 1자
  '의',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '에',
  '로',
  '와',
  '과',
  '도',
  '만',
  '나',
];

/** 경계로 자르고 빈 조각을 버린다 — 두 함수가 공유하는 단 하나의 분해 지점 */
function split(text: string): string[] {
  return text.split(BOUNDARY).filter((piece) => piece.length > 0);
}

/**
 * 격조사 하나를 뗀다. **떼고 나서 2자 미만이 되면 떼지 않는다** — `나를`에서 `를`을 떼면
 * 변별력이 사라지고 원형이 `나를`인지 `나`+조사인지도 구분할 수 없다. 원 토큰을 두는 편이
 * 정보가 많다.
 */
function stripParticle(eojeol: string): string {
  for (const particle of CASE_PARTICLES) {
    if (!eojeol.endsWith(particle)) continue;
    const stem = eojeol.slice(0, eojeol.length - particle.length);
    return stem.length < MIN_LENGTH ? eojeol : stem;
  }
  return eojeol;
}

/** 등장 순서를 지키며 중복을 제거한다 */
function distinct(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

/** 질의 토큰 — 격조사 절단 후 2자 미만은 버린다. 등장 순서·중복 제거. */
export function tokenize(text: string): string[] {
  return distinct(
    split(text)
      .map(stripParticle)
      .filter((token) => token.length >= MIN_LENGTH),
  );
}

/**
 * 어휘 항 — 조사를 떼지 않은 raw 어절.
 *
 * 2자 미만 어절은 넣지 않는다: 질의 토큰이 2자 이상이므로 그보다 짧은 어절에는 부분문자열로
 * 들어갈 수 없어, 담아도 아무 토큰과도 매칭되지 않는다.
 */
export function eojeolsOf(text: string): string[] {
  return distinct(split(text).filter((eojeol) => eojeol.length >= MIN_LENGTH));
}
