// docs/specs/32 수용 기준 4~5 동결 테스트 — 구현 중 수정 금지
import {
  JUDGE_RUBRIC,
  normalizeJudgement,
} from './openai-groundedness-judge';

const validRaw = {
  claims: 1,
  supported: 1,
  miscited: 0,
  unsupported: 0,
  unsupportedExamples: [],
  insufficiencyDisclosed: false,
  verdict: 'grounded',
};

describe('spec 32: qa-v5 groundedness 심판 계약', () => {
  it('기준 4a: JSON 출력에 miscited 주장 원문 예시를 최대 2개 요구한다', () => {
    expect(JUDGE_RUBRIC).toMatch(
      /JSON만 출력:[\s\S]*"miscitedExamples"\s*:\s*\[[^\]]*(?:원문|예시)[^\]]*최대\s*2개[^\]]*\]/,
    );
  });

  it('기준 4b: rubric v3의 비주장 예외와 남용 가드를 그대로 유지한다', () => {
    expect(JUDGE_RUBRIC).toContain('면책');
    expect(JUDGE_RUBRIC).toContain('적용 지침');
    expect(JUDGE_RUBRIC).toContain('한계 고지');
    expect(JUDGE_RUBRIC).toContain('근거 상태 논평');
    expect(JUDGE_RUBRIC).toContain('재질의 유도');
    expect(JUDGE_RUBRIC).toContain('마커가 붙어 있어도');
    expect(JUDGE_RUBRIC).toContain('miscited로 세지 마세요');
    expect(JUDGE_RUBRIC).toContain('구체 임상 정보');
    expect(JUDGE_RUBRIC).toContain('절 단위');
  });

  it('기준 5a: miscitedExamples 키가 없으면 빈 배열로 정규화한다', () => {
    const judgement = normalizeJudgement({ ...validRaw });

    expect(judgement.miscitedExamples).toEqual([]);
  });

  it('기준 5b: miscitedExamples가 배열이 아니면 빈 배열로 정규화한다', () => {
    for (const miscitedExamples of ['잘못된 단일 문자열', 42, null]) {
      const judgement = normalizeJudgement({
        ...validRaw,
        miscitedExamples,
      });

      expect(judgement.miscitedExamples).toEqual([]);
    }
  });

  it('기준 5c: miscitedExamples에서 문자열이 아닌 원소를 버린다', () => {
    const judgement = normalizeJudgement({
      ...validRaw,
      miscitedExamples: ['진짜 주장', 42, null],
    });

    expect(judgement.miscitedExamples).toEqual(['진짜 주장']);
  });

  it('기준 5d: miscitedExamples를 앞에서 최대 2개로 자른다', () => {
    const judgement = normalizeJudgement({
      ...validRaw,
      miscitedExamples: ['첫 번째 주장', '두 번째 주장', '세 번째 주장'],
    });

    expect(judgement.miscitedExamples).toEqual([
      '첫 번째 주장',
      '두 번째 주장',
    ]);
  });
});
