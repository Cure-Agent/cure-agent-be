// docs/specs/31 수용 기준 8~8 동결 테스트 — 구현 중 수정 금지
import { retrievalConfig } from './retrieval.config';

describe('spec 31 기준 8: 하이브리드 검색 env 기본값 규약', () => {
  const originalEnabled = process.env.RETRIEVAL_HYBRID_ENABLED;

  afterEach(() => {
    if (originalEnabled === undefined) {
      delete process.env.RETRIEVAL_HYBRID_ENABLED;
    } else {
      process.env.RETRIEVAL_HYBRID_ENABLED = originalEnabled;
    }
  });

  it('기준 8a: RETRIEVAL_HYBRID_ENABLED 미지정이면 코드 기본값 true를 쓴다', () => {
    delete process.env.RETRIEVAL_HYBRID_ENABLED;

    expect(retrievalConfig().hybridEnabled).toBe(true);
  });

  it('기준 8b: RETRIEVAL_HYBRID_ENABLED가 빈 문자열이면 코드 기본값 true를 쓴다', () => {
    process.env.RETRIEVAL_HYBRID_ENABLED = '';

    expect(retrievalConfig().hybridEnabled).toBe(true);
  });

  it("기준 8c: RETRIEVAL_HYBRID_ENABLED가 'false'면 false를 쓴다", () => {
    delete process.env.RETRIEVAL_HYBRID_ENABLED;
    expect(retrievalConfig().hybridEnabled).toBe(true);

    process.env.RETRIEVAL_HYBRID_ENABLED = 'false';

    expect(retrievalConfig().hybridEnabled).toBe(false);
  });
});
