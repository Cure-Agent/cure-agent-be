// docs/specs/48 수용 기준 24 동결 테스트 — 구현 중 수정 금지
import { retrievalConfig } from './retrieval.config';

describe('spec 48 기준 24: 키워드 후보 예산 기본값', () => {
  const originalBudget = process.env.RETRIEVAL_KEYWORD_CANDIDATE_BUDGET;
  const originalPrefilter = process.env.RETRIEVAL_VOCAB_PREFILTER_ENABLED;

  afterEach(() => {
    if (originalBudget === undefined) {
      delete process.env.RETRIEVAL_KEYWORD_CANDIDATE_BUDGET;
    } else {
      process.env.RETRIEVAL_KEYWORD_CANDIDATE_BUDGET = originalBudget;
    }
    if (originalPrefilter === undefined) {
      delete process.env.RETRIEVAL_VOCAB_PREFILTER_ENABLED;
    } else {
      process.env.RETRIEVAL_VOCAB_PREFILTER_ENABLED = originalPrefilter;
    }
  });

  it('예산 env가 미지정이면 코드 기본값 75이고 프리필터 기본값은 true다', () => {
    delete process.env.RETRIEVAL_KEYWORD_CANDIDATE_BUDGET;
    delete process.env.RETRIEVAL_VOCAB_PREFILTER_ENABLED;

    expect(retrievalConfig()).toMatchObject({
      keywordCandidateBudget: 75,
      vocabPrefilterEnabled: true,
    });
  });

  it('두 env가 빈 문자열이어도 예산 75와 프리필터 true를 쓴다', () => {
    process.env.RETRIEVAL_KEYWORD_CANDIDATE_BUDGET = '';
    process.env.RETRIEVAL_VOCAB_PREFILTER_ENABLED = '';

    expect(retrievalConfig()).toMatchObject({
      keywordCandidateBudget: 75,
      vocabPrefilterEnabled: true,
    });
  });

  it('유효한 양수 문자열은 그 숫자를 후보 예산으로 읽는다', () => {
    process.env.RETRIEVAL_KEYWORD_CANDIDATE_BUDGET = '17';

    expect(retrievalConfig().keywordCandidateBudget).toBe(17);
  });
});
