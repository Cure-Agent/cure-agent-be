// docs/specs/48 수용 기준 1~8·25 동결 테스트 — 구현 중 수정 금지
import { GuidelineRepository } from '../repository/guideline.repository';
import { KeywordVocabularyService } from './keyword-vocabulary.service';

interface SyntheticVocab {
  index: { chunkId: string; ix: number }[];
  terms: { term: string; chunkIxs: number[] }[];
}

function serviceWith({ index, terms }: SyntheticVocab): KeywordVocabularyService {
  const repository = {
    loadVocabTerms: jest.fn().mockResolvedValue(terms),
    loadChunkIndex: jest.fn().mockResolvedValue(index),
  } as unknown as GuidelineRepository;
  return new KeywordVocabularyService(repository);
}

function indexedChunks(count: number): { chunkId: string; ix: number }[] {
  return Array.from({ length: count }, (_, ix) => ({
    chunkId: `chunk-${String(ix).padStart(2, '0')}`,
    ix,
  }));
}

describe('spec 48: BM25 예산 후보 선택', () => {
  const originalCommonRatio = process.env.RETRIEVAL_VOCAB_COMMON_DF_RATIO;

  afterEach(() => {
    if (originalCommonRatio === undefined) {
      delete process.env.RETRIEVAL_VOCAB_COMMON_DF_RATIO;
    } else {
      process.env.RETRIEVAL_VOCAB_COMMON_DF_RATIO = originalCommonRatio;
    }
  });

  it('기준 1: 매칭 청크가 예산보다 많을 때 실제로 자르고 후보 수를 예산에 맞춘다', async () => {
    const index = indexedChunks(5);
    const service = serviceWith({
      index,
      terms: [{ term: '예산표식', chunkIxs: index.map(({ ix }) => ix) }],
    });

    const selected = await service.selectCandidates('예산표식', 3);

    expect(selected.tokens[0].df).toBe(5);
    expect(selected.tokens[0].df).toBeGreaterThan(3);
    expect(selected.chunkIds).toHaveLength(3);
    expect(selected.chunkIds).toEqual(['chunk-00', 'chunk-01', 'chunk-02']);
  });

  it('기준 2: 매칭 수가 예산 미만이면 전부 남기되 미매칭 0점 청크로 빈칸을 채우지 않는다', async () => {
    const service = serviceWith({
      index: indexedChunks(3),
      terms: [
        { term: '대상표식', chunkIxs: [0, 1] },
        { term: '질의무관어휘', chunkIxs: [2] },
      ],
    });

    const selected = await service.selectCandidates('대상표식', 3);

    expect(selected.tokens).toEqual([
      { token: '대상표식', df: 2, common: true },
    ]);
    expect(selected.tokens[0].df).toBeLessThan(3);
    expect(selected.chunkIds).toEqual(['chunk-00', 'chunk-01']);
    expect(selected.chunkIds).not.toContain('chunk-02');
  });

  it('기준 3: 5% 기준으로 common인 토큰도 라벨은 유지한 채 후보 생성에 기여한다', async () => {
    const index = indexedChunks(20);
    const service = serviceWith({
      index,
      terms: [
        { term: '흔한표식', chunkIxs: [0, 1] },
        ...index.map(({ ix }) => ({
          term: `배경어휘${String(ix).padStart(2, '0')}`,
          chunkIxs: [ix],
        })),
      ],
    });

    const selected = await service.selectCandidates('흔한표식', 2);

    expect(selected.tokens).toEqual([
      { token: '흔한표식', df: 2, common: true },
    ]);
    expect(selected.chunkIds).toEqual(['chunk-00', 'chunk-01']);
  });

  it('기준 4: 여러 매칭 어절형의 tf=2가 한 어절형의 tf=1보다 높게 득점한다', async () => {
    const service = serviceWith({
      index: [
        { chunkId: 'tf-z', ix: 0 },
        { chunkId: 'tf-a', ix: 1 },
      ],
      terms: [
        { term: '임상적', chunkIxs: [0, 1] },
        { term: '임상연구', chunkIxs: [0] },
        { term: '길이보정어', chunkIxs: [1] },
      ],
    });

    // N=2, df=2, avgdl=2, dl은 둘 다 2다. 명세 식의 tf 포화항은
    // tf-z=1.375, tf-a=1.000이므로 id가 더 큰 tf-z가 남아야 한다.
    const selected = await service.selectCandidates('임상', 1);

    expect(selected.tokens[0].df).toBe(2);
    expect(selected.chunkIds).toEqual(['tf-z']);
    expect(selected.chunkIds).not.toContain('tf-a');
  });

  it('기준 5: 같은 tf·dl에서는 작은 df의 IDF 기여가 큰 df보다 커야 한다', async () => {
    const index = indexedChunks(20).map(({ ix }) => ({
      chunkId: ix === 0 ? 'idf-z-rare' : `idf-${String(ix).padStart(2, '0')}`,
      ix,
    }));
    const service = serviceWith({
      index,
      terms: [
        { term: '희소표식형', chunkIxs: [0] },
        { term: '빈번표식형', chunkIxs: [1, 2, 3, 4, 5, 6] },
        ...index.map(({ ix }) => ({ term: `길이맞춤${ix}`, chunkIxs: [ix] })),
      ],
    });

    // N=20에서 IDF(df=1)=ln(14), IDF(df=6)=ln(42/13)이다.
    // 매칭 후보의 tf=1·dl=2가 같으므로 희소 토큰 청크만 예산 1에 남는다.
    const selected = await service.selectCandidates('희소표식 빈번표식', 1);

    expect(selected.tokens.map(({ token, df }) => ({ token, df }))).toEqual([
      { token: '희소표식', df: 1 },
      { token: '빈번표식', df: 6 },
    ]);
    expect(selected.chunkIds).toEqual(['idf-z-rare']);
  });

  it('기준 6: 같은 tf에서는 dl이 짧은 청크가 길이 정규화로 더 높게 득점한다', async () => {
    const service = serviceWith({
      index: [
        { chunkId: 'length-z-short', ix: 0 },
        { chunkId: 'length-a-long', ix: 1 },
      ],
      terms: [
        { term: '길이표식', chunkIxs: [0, 1] },
        { term: '긴문서보정하나', chunkIxs: [1] },
        { term: '긴문서보정둘', chunkIxs: [1] },
        { term: '긴문서보정셋', chunkIxs: [1] },
        { term: '긴문서보정넷', chunkIxs: [1] },
      ],
    });

    // N=2, avgdl=3, tf=1은 같다. dl=1의 포화항은 1.375,
    // dl=5는 약 0.786이므로 id가 더 큰 short 청크가 이겨야 한다.
    const selected = await service.selectCandidates('길이표식', 1);

    expect(selected.chunkIds).toEqual(['length-z-short']);
    expect(selected.chunkIds).not.toContain('length-a-long');
  });

  it('기준 7: BM25 점수가 정확히 같으면 청크 id 오름차순으로 예산을 자른다', async () => {
    const service = serviceWith({
      index: [
        { chunkId: 'tie-z', ix: 0 },
        { chunkId: 'tie-a', ix: 1 },
      ],
      terms: [{ term: '동점표식', chunkIxs: [0, 1] }],
    });

    const selected = await service.selectCandidates('동점표식', 1);

    expect(selected.chunkIds).toEqual(['tie-a']);
  });

  it('기준 8: 미등재 토큰을 섞어도 후보는 같고 그 토큰의 df는 0이다', async () => {
    const service = serviceWith({
      index: indexedChunks(3),
      terms: [
        { term: '등재표식', chunkIxs: [0, 2] },
        { term: '무관어휘', chunkIxs: [1] },
      ],
    });

    const registeredOnly = await service.selectCandidates('등재표식', 2);
    const withUnknown = await service.selectCandidates(
      '등재표식 코퍼스밖신조어',
      2,
    );

    expect(withUnknown.chunkIds).toEqual(registeredOnly.chunkIds);
    expect(withUnknown.tokens).toContainEqual({
      token: '코퍼스밖신조어',
      df: 0,
      common: false,
    });
  });

  it('기준 25: 제거된 common ratio env는 후보와 고정 5% common 라벨 모두 바꾸지 않는다', async () => {
    const index = indexedChunks(20);
    const vocab = {
      index,
      terms: [
        { term: '고정컷표식', chunkIxs: [0, 1] },
        ...index.map(({ ix }) => ({ term: `환경배경${ix}`, chunkIxs: [ix] })),
      ],
    };

    delete process.env.RETRIEVAL_VOCAB_COMMON_DF_RATIO;
    const withoutEnv = await serviceWith(vocab).selectCandidates('고정컷표식', 2);
    process.env.RETRIEVAL_VOCAB_COMMON_DF_RATIO = '0.99';
    const withRemovedEnv = await serviceWith(vocab).selectCandidates('고정컷표식', 2);

    expect(withRemovedEnv).toEqual(withoutEnv);
    expect(withoutEnv.tokens).toEqual([
      { token: '고정컷표식', df: 2, common: true },
    ]);
    expect(withRemovedEnv.tokens).toEqual(withoutEnv.tokens);
  });
});
