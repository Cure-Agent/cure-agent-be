import { containsRecommendationMarker } from './guideline-chunker';

describe('containsRecommendationMarker', () => {
  it('returns false when no page contains a recommendation marker', () => {
    expect(
      containsRecommendationMarker([
        '1\n진료지침 매뉴얼\n권고 마커를 사용하지 않는 문서다.',
        '2\n부록\n【참고】 관련 자료를 확인한다.',
      ]),
    ).toBe(false);
  });

  it('returns true when a recommendation marker is at the start of a line', () => {
    expect(
      containsRecommendationMarker(['1\nIV 권고사항\n【 R1 】 첫 번째 권고']),
    ).toBe(true);
  });

  it('returns true when a recommendation marker is in the middle of a line', () => {
    expect(
      containsRecommendationMarker([
        '1\n결과 요약\n요약표에서 【R2】를 다시 인용한다',
      ]),
    ).toBe(true);
  });

  it.each([
    ['without inner whitespace', '본문 【R1】 권고'],
    ['with inner whitespace', '본문 【 R1 】 권고'],
    ['with a hyphenated sub-number', '본문 【 R13-2 】 권고'],
  ])('returns true for a valid marker %s', (_case, line) => {
    expect(containsRecommendationMarker([line])).toBe(true);
  });

  it('returns false for an empty page array', () => {
    expect(containsRecommendationMarker([])).toBe(false);
  });

  it.each([
    ['reference text', '본문 【참고】 설명'],
    ['R without a number', '본문 【R】 설명'],
    ['brackets without marker text', '본문 【 】 설명'],
  ])('does not count %s as a recommendation marker', (_case, line) => {
    expect(containsRecommendationMarker([line])).toBe(false);
  });
});
