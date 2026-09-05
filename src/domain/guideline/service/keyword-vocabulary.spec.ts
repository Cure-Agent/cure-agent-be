// docs/specs/45 수용 기준 4~6 동결 테스트 — 구현 중 수정 금지
import { GuidelineRepository } from '../repository/guideline.repository';
import { KeywordVocabularyService } from './keyword-vocabulary.service';

const chunkIndex = Array.from({ length: 20 }, (_, ix) => ({
  chunkId: `chunk-${String(ix).padStart(2, '0')}`,
  ix,
}));

const vocabTerms = [
  { term: '빈번표식', chunkIxs: [0, 1] },
  { term: '희소별빛', chunkIxs: [2] },
  ...chunkIndex.map(({ ix }) => ({ term: `기저어휘${ix}`, chunkIxs: [ix] })),
];

function serviceWithSyntheticVocab(): KeywordVocabularyService {
  const repository = {
    loadVocabTerms: jest.fn().mockResolvedValue(vocabTerms),
    loadChunkIndex: jest.fn().mockResolvedValue(chunkIndex),
  } as unknown as GuidelineRepository;
  return new KeywordVocabularyService(repository);
}

describe('spec 45 기준 4~6: 부분문자열 DF와 후보 합집합', () => {
  it('기준 4: 20청크의 5% 컷 1을 초과한 DF 2 토큰은 후보에 기여하지 않는다', async () => {
    const selected = await serviceWithSyntheticVocab().selectCandidates(
      '빈번표식 희소별빛',
    );

    expect(selected.tokens).toEqual([
      { token: '빈번표식', df: 2, common: true },
      { token: '희소별빛', df: 1, common: false },
    ]);
    expect(selected.chunkIds).toEqual(['chunk-02']);
    expect(selected.chunkIds).not.toContain('chunk-00');
    expect(selected.chunkIds).not.toContain('chunk-01');
  });

  it('기준 5: 20청크의 5% 컷과 정확히 같은 DF 1 토큰은 후보 생성에 쓰인다', async () => {
    const selected = await serviceWithSyntheticVocab().selectCandidates(
      '희소별빛',
    );

    expect(selected.tokens).toEqual([
      { token: '희소별빛', df: 1, common: false },
    ]);
    expect(selected.chunkIds).toEqual(['chunk-02']);
  });

  it('기준 6: 미등재 토큰을 같은 질의에 추가해도 희소 토큰의 후보 집합은 달라지지 않는다', async () => {
    const service = serviceWithSyntheticVocab();
    const registeredOnly = await service.selectCandidates('희소별빛');
    const withUnknown = await service.selectCandidates(
      '희소별빛 코퍼스밖신조어',
    );

    expect(withUnknown.tokens).toEqual([
      { token: '희소별빛', df: 1, common: false },
      { token: '코퍼스밖신조어', df: 0, common: false },
    ]);
    expect(withUnknown.chunkIds).toEqual(registeredOnly.chunkIds);
    expect(withUnknown.chunkIds).toEqual(['chunk-02']);
  });
});
