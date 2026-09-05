// docs/specs/45 수용 기준 25 동결 테스트 — 구현 중 수정 금지
import { retrievalConfig } from './retrieval.config';

describe('spec 45 기준 25: 어휘 프리필터 env 기본값 규약', () => {
  const originalEnabled = process.env.RETRIEVAL_VOCAB_PREFILTER_ENABLED;
  const originalRatio = process.env.RETRIEVAL_VOCAB_COMMON_DF_RATIO;

  afterEach(() => {
    if (originalEnabled === undefined) {
      delete process.env.RETRIEVAL_VOCAB_PREFILTER_ENABLED;
    } else {
      process.env.RETRIEVAL_VOCAB_PREFILTER_ENABLED = originalEnabled;
    }
    if (originalRatio === undefined) {
      delete process.env.RETRIEVAL_VOCAB_COMMON_DF_RATIO;
    } else {
      process.env.RETRIEVAL_VOCAB_COMMON_DF_RATIO = originalRatio;
    }
  });

  it('기준 25: 두 환경변수 미지정이면 기본값 true와 0.05를 함께 쓴다', () => {
    delete process.env.RETRIEVAL_VOCAB_PREFILTER_ENABLED;
    delete process.env.RETRIEVAL_VOCAB_COMMON_DF_RATIO;

    expect(retrievalConfig().vocabPrefilterEnabled).toBe(true);
    expect(retrievalConfig().vocabCommonDfRatio).toBe(0.05);
  });

  it('기준 25: 두 환경변수가 빈 문자열이어도 기본값 true와 0.05를 함께 쓴다', () => {
    process.env.RETRIEVAL_VOCAB_PREFILTER_ENABLED = '';
    process.env.RETRIEVAL_VOCAB_COMMON_DF_RATIO = '';

    expect(retrievalConfig().vocabPrefilterEnabled).toBe(true);
    expect(retrievalConfig().vocabCommonDfRatio).toBe(0.05);
  });

  it("기준 25: 'false'는 실제로 끄고 유효한 비율 문자열은 숫자로 읽는다", () => {
    delete process.env.RETRIEVAL_VOCAB_PREFILTER_ENABLED;
    delete process.env.RETRIEVAL_VOCAB_COMMON_DF_RATIO;
    expect(retrievalConfig().vocabPrefilterEnabled).toBe(true);
    expect(retrievalConfig().vocabCommonDfRatio).toBe(0.05);

    process.env.RETRIEVAL_VOCAB_PREFILTER_ENABLED = 'false';
    process.env.RETRIEVAL_VOCAB_COMMON_DF_RATIO = '0.075';

    expect(retrievalConfig().vocabPrefilterEnabled).toBe(false);
    expect(retrievalConfig().vocabCommonDfRatio).toBe(0.075);
  });
});
