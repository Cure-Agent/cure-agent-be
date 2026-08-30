import { ABSTAIN_REASON_MESSAGE } from './conversation.mapper';

describe('ABSTAIN_REASON_MESSAGE 문구 회귀 계약', () => {
  it('[기준 13] 한국어 세 문구는 spec 42에서 잠근 자구와 정확히 같다', () => {
    expect(ABSTAIN_REASON_MESSAGE.ko).toEqual({
      no_candidates: '검색 조건에 해당하는 지침 근거를 찾지 못했습니다.',
      beyond_cutoff: '질문과 충분히 관련된 지침 근거를 찾지 못했습니다.',
      insufficient_evidence:
        '찾은 지침 근거만으로는 이 질문에 답하기 어렵습니다.',
    });
  });

  it('[기준 14] 영문 세 문구는 spec 42에서 잠근 자구와 정확히 같다', () => {
    expect(ABSTAIN_REASON_MESSAGE.en).toEqual({
      no_candidates:
        'No guideline evidence matched the selected search filters.',
      beyond_cutoff:
        'No guideline evidence was closely enough related to this question.',
      insufficient_evidence:
        'The guideline evidence found is not sufficient to answer this question.',
    });
  });
});
