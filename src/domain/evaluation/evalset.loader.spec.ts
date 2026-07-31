import { EvalSetSchemaError, loadEvalSet } from './evalset.loader';

const approvedItem = {
  id: 'approved-1',
  kind: 'answerable',
  question: '만성 요통 환자에게 침 치료를 권고할 수 있나요?',
  expectedEvidence: [
    {
      guidelineTitle: '요통 한의표준임상진료지침',
      publisher: '한국한의약진흥원',
      recommendationNumber: 'R1',
    },
  ],
  status: 'approved',
  origin: 'manual',
};

describe('spec 27: 평가셋 로더', () => {
  it('기준 3a: approved 항목만 평가 대상으로 반환한다', () => {
    const candidateItem = {
      ...approvedItem,
      id: 'candidate-1',
      status: 'candidate',
    };
    const rejectedItem = {
      ...approvedItem,
      id: 'rejected-1',
      status: 'rejected',
    };

    expect(loadEvalSet([candidateItem, approvedItem, rejectedItem])).toEqual([
      approvedItem,
    ]);
  });

  it('기준 3b-i: guidelineTitle이 없는 안정 키를 EvalSetSchemaError로 거부한다', () => {
    const invalidItem = {
      ...approvedItem,
      expectedEvidence: [
        {
          publisher: '한국한의약진흥원',
          recommendationNumber: 'R1',
        },
      ],
    };

    expect(() => loadEvalSet([invalidItem])).toThrow(EvalSetSchemaError);
  });

  it('기준 3b-i: publisher가 없는 안정 키를 EvalSetSchemaError로 거부한다', () => {
    const invalidItem = {
      ...approvedItem,
      expectedEvidence: [
        {
          guidelineTitle: '요통 한의표준임상진료지침',
          recommendationNumber: 'R1',
        },
      ],
    };

    expect(() => loadEvalSet([invalidItem])).toThrow(EvalSetSchemaError);
  });

  it('기준 3b-ii: recommendationNumber와 sectionPath가 모두 없는 안정 키를 EvalSetSchemaError로 거부한다', () => {
    const invalidItem = {
      ...approvedItem,
      expectedEvidence: [
        {
          guidelineTitle: '요통 한의표준임상진료지침',
          publisher: '한국한의약진흥원',
        },
      ],
    };

    expect(() => loadEvalSet([invalidItem])).toThrow(EvalSetSchemaError);
  });

  it('기준 3b-ii 대조군: sectionPath가 있으면 recommendationNumber 없이도 정상으로 받는다', () => {
    const sectionItem = {
      ...approvedItem,
      id: 'approved-section-1',
      expectedEvidence: [
        {
          guidelineTitle: '요통 한의표준임상진료지침',
          publisher: '한국한의약진흥원',
          sectionPath: ['1', '진단'],
        },
      ],
    };

    expect(loadEvalSet([sectionItem])).toEqual([sectionItem]);
  });

  it('기준 3c: answerable 문항의 expectedEvidence가 비어 있으면 EvalSetSchemaError로 거부한다', () => {
    const invalidItem = {
      ...approvedItem,
      expectedEvidence: [],
    };

    expect(() => loadEvalSet([invalidItem])).toThrow(EvalSetSchemaError);
  });

  it('기준 3c 대조군: abstain 문항의 빈 expectedEvidence는 정상으로 받는다', () => {
    const abstainItem = {
      id: 'abstain-1',
      kind: 'abstain',
      question: '관상동맥 스텐트 시술 적응증은 무엇인가요?',
      expectedEvidence: [],
      status: 'approved',
      origin: 'manual',
    };

    expect(loadEvalSet([abstainItem])).toEqual([abstainItem]);
  });
});
