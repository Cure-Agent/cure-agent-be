// docs/specs/29 수용 기준 9 동결 테스트 — 구현 중 수정 금지
import { retrievalConfig } from './retrieval.config';

describe('spec 29 기준 9: 리랭크 env 기본값 규약', () => {
  const originalCandidates = process.env.RETRIEVAL_RERANK_CANDIDATES;
  const originalScoreCutoff = process.env.RETRIEVAL_RERANK_SCORE_CUTOFF;
  const originalEnabled = process.env.RETRIEVAL_RERANK_ENABLED;

  afterEach(() => {
    if (originalCandidates === undefined) {
      delete process.env.RETRIEVAL_RERANK_CANDIDATES;
    } else {
      process.env.RETRIEVAL_RERANK_CANDIDATES = originalCandidates;
    }

    if (originalScoreCutoff === undefined) {
      delete process.env.RETRIEVAL_RERANK_SCORE_CUTOFF;
    } else {
      process.env.RETRIEVAL_RERANK_SCORE_CUTOFF = originalScoreCutoff;
    }

    if (originalEnabled === undefined) {
      delete process.env.RETRIEVAL_RERANK_ENABLED;
    } else {
      process.env.RETRIEVAL_RERANK_ENABLED = originalEnabled;
    }
  });

  it('기준 9a: RETRIEVAL_RERANK_CANDIDATES가 미지정이면 코드 기본값 30을 쓴다', () => {
    delete process.env.RETRIEVAL_RERANK_CANDIDATES;

    expect(retrievalConfig().rerankCandidates).toBe(30);
  });

  it('기준 9a: RETRIEVAL_RERANK_CANDIDATES가 빈 문자열이면 코드 기본값 30을 쓴다', () => {
    process.env.RETRIEVAL_RERANK_CANDIDATES = '';

    expect(retrievalConfig().rerankCandidates).toBe(30);
  });

  // 기본값 6 → 9 상향 (issue #232): abstain 44문항 실측에서 기권 실패가 전부 6~8점에
  // 몰렸고, answerable 183/185는 9~10점이다. 컷은 두 분포 사이로 옮겨야 한다.
  it('기준 9b: RETRIEVAL_RERANK_SCORE_CUTOFF가 미지정이면 코드 기본값 9를 쓴다', () => {
    delete process.env.RETRIEVAL_RERANK_SCORE_CUTOFF;

    expect(retrievalConfig().rerankScoreCutoff).toBe(9);
  });

  it('기준 9b: RETRIEVAL_RERANK_SCORE_CUTOFF가 빈 문자열이면 코드 기본값 9를 쓴다', () => {
    process.env.RETRIEVAL_RERANK_SCORE_CUTOFF = '';

    expect(retrievalConfig().rerankScoreCutoff).toBe(9);
  });

  it("기준 9c: RETRIEVAL_RERANK_ENABLED 미지정은 true, 'false'는 false다", () => {
    delete process.env.RETRIEVAL_RERANK_ENABLED;
    expect(retrievalConfig().rerankEnabled).toBe(true);

    process.env.RETRIEVAL_RERANK_ENABLED = 'false';
    expect(retrievalConfig().rerankEnabled).toBe(false);
  });

  it("기준 9d: candidates '20'과 score cutoff '7'을 숫자로 전달한다", () => {
    process.env.RETRIEVAL_RERANK_CANDIDATES = '20';
    process.env.RETRIEVAL_RERANK_SCORE_CUTOFF = '7';

    const config = retrievalConfig();
    expect(config.rerankCandidates).toBe(20);
    expect(config.rerankScoreCutoff).toBe(7);
  });
});
