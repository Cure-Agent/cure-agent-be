import { normalizeRanking } from './openai-reranker';

describe('리랭커 순위 정규화 (docs/specs/29 실운영 보강)', () => {
  it('숫자 문자열을 수용한다 — 모델이 간헐적으로 "3" 형태로 낸다', () => {
    expect(normalizeRanking(['3', '1', '2'], 30)).toEqual([3, 1, 2]);
  });

  it('범위 밖·비정수·중복을 걸러내고 순서를 보존한다', () => {
    expect(normalizeRanking([2, 99, 0, 2.5, 'x', 2, 1], 30)).toEqual([2, 1]);
  });

  it('배열이 아니거나 유효 항목이 없으면 빈 배열 — 호출측이 폴백을 판단한다', () => {
    expect(normalizeRanking('1,2,3', 30)).toEqual([]);
    expect(normalizeRanking([null, 'abc'], 30)).toEqual([]);
  });
});
