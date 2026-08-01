// docs/specs/28 수용 기준 7 동결 테스트 — 구현 중 수정 금지
import { retrievalConfig } from './retrieval.config';

describe('spec 28 기준 7: 검색 거리 임계값 env 기본값 규약', () => {
  const originalCutoff = process.env.RETRIEVAL_DISTANCE_CUTOFF;

  afterEach(() => {
    if (originalCutoff === undefined) {
      delete process.env.RETRIEVAL_DISTANCE_CUTOFF;
    } else {
      process.env.RETRIEVAL_DISTANCE_CUTOFF = originalCutoff;
    }
  });

  it('기준 7a: RETRIEVAL_DISTANCE_CUTOFF가 미지정이면 코드 기본값 0.48을 쓴다', () => {
    delete process.env.RETRIEVAL_DISTANCE_CUTOFF;

    expect(retrievalConfig().distanceCutoff).toBe(0.48);
  });

  it("기준 7b: RETRIEVAL_DISTANCE_CUTOFF가 빈 문자열이면 코드 기본값 0.48을 쓴다", () => {
    process.env.RETRIEVAL_DISTANCE_CUTOFF = '';

    expect(retrievalConfig().distanceCutoff).toBe(0.48);
  });

  it("기준 7c: RETRIEVAL_DISTANCE_CUTOFF가 '0.5'면 숫자 0.5를 전달한다", () => {
    process.env.RETRIEVAL_DISTANCE_CUTOFF = '0.5';

    expect(retrievalConfig().distanceCutoff).toBe(0.5);
  });
});
