// docs/specs/45 수용 기준 3 동결 테스트 — 구현 중 수정 금지
import { eojeolsOf, tokenize } from './query-tokenizer';

const CASE_PARTICLES = [
  '에서는',
  '에게서',
  '으로서',
  '으로써',
  '이라도',
  '이라는',
  '에서도',
  '에게도',
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
] as const;

describe('spec 45 기준 3: 질의와 어휘의 공유 토크나이저', () => {
  it('기준 3a: eojeolsOf는 조사 절단 전 raw 어절 환자에게를 그대로 둔다', () => {
    expect(eojeolsOf('환자에게 치료를 권고한다')).toEqual([
      '환자에게',
      '치료를',
      '권고한다',
    ]);
    expect(eojeolsOf('환자에게 치료를 권고한다')).not.toContain('환자');
  });

  it('기준 3b: 환자에게서의 질의 토큰 환자는 raw 어휘 항 환자에게를 부분문자열로 찾는다', () => {
    const tokens = tokenize('환자에게서');
    const terms = eojeolsOf('환자에게 진료를 제공한다');

    expect(tokens).toEqual(['환자']);
    expect(terms).toContain('환자에게');
    expect(terms.filter((term) => term.includes(tokens[0]))).toEqual([
      '환자에게',
    ]);
  });

  it('기준 3c: 숫자·영문·한글만 어절에 남기고 그 밖의 경계와 빈 조각을 버린다', () => {
    expect(tokenize('___A1한글___beta---감마!!!42가...')).toEqual([
      'A1한글',
      'beta',
      '감마',
      '42',
    ]);
  });

  it('기준 3c: 명세의 격조사 43개를 긴 것부터 검사해 정확히 하나만 뗀다', () => {
    expect(CASE_PARTICLES).toHaveLength(43);
    for (const particle of CASE_PARTICLES) {
      expect(tokenize(`표적어${particle}`)).toEqual(['표적어']);
    }

    // 짧은 `는`을 먼저 떼면 `치료에서`이 남고, 반복 절단하면 명세의 "하나만"을 어긴다.
    expect(tokenize('치료에서는')).toEqual(['치료']);
    expect(tokenize('치료로에서는')).toEqual(['치료로']);
  });

  it('기준 3c: 조사 제거 결과가 2자 미만이면 나를을 원형 그대로 둔다', () => {
    expect(tokenize('나를')).toEqual(['나를']);
  });

  it('기준 3c: 질의의 2자 미만 토큰을 버리고 등장 순서대로 중복을 제거한다', () => {
    expect(tokenize('가 A 1 환자에게 치료를 환자에게 42')).toEqual([
      '환자',
      '치료',
      '42',
    ]);
  });

  it('기준 3c: eojeolsOf는 조사를 떼지 않으며 2자 미만 raw 어절만 버린다', () => {
    expect(eojeolsOf('가 A 1 환자에게 치료를 42 A1한글')).toEqual([
      '환자에게',
      '치료를',
      '42',
      'A1한글',
    ]);
  });
});
