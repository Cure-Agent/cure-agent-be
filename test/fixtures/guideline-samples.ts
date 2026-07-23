import { GuidelineIngestInput } from '../../src/domain/guideline/service/guideline-ingest.input';

/** 수용 기준 검증용 샘플 — 실제 지침이 아닌 테스트 데이터다. */
export const yotongGuideline: GuidelineIngestInput = {
  title: '요통 한의표준임상진료지침',
  publisher: '한국한의약진흥원',
  version: '1.0',
  publishedAt: '2021-06-01',
  sourceUrl: 'https://nckm.example.org/guideline/lbp',
  sections: [
    {
      path: ['1', '진단'],
      title: '진단',
      order: 1,
      chunks: [
        {
          content:
            '요통 환자의 초기 평가에서는 중증 질환을 시사하는 적색 신호(red flag)를 감별해야 한다.',
          pageStart: 12,
          pageEnd: 13,
        },
      ],
    },
    {
      path: ['2', '치료', '침치료'],
      title: '침 치료',
      order: 2,
      chunks: [
        {
          content: '만성 요통 환자에게 통증 감소와 기능 개선을 위해 침 치료를 시행할 것을 권고한다.',
          recommendationNumber: 'R1',
          recommendationGrade: { system: 'GRADE', code: 'A', label: '강한 권고' },
          evidenceLevel: { system: 'GRADE', code: 'HIGH', label: '높음' },
          pageStart: 45,
          pageEnd: 46,
        },
        {
          content: '급성 요통 환자에게 전침 병행 치료를 고려할 수 있다.',
          recommendationNumber: 'R2',
          recommendationGrade: { system: 'GRADE', code: 'B', label: '약한 권고' },
          evidenceLevel: { system: 'GRADE', code: 'MODERATE', label: '중등도' },
          pageStart: 47,
          pageEnd: 47,
        },
      ],
    },
  ],
};

export const gyeonbitongGuideline: GuidelineIngestInput = {
  title: '견비통 한의표준임상진료지침',
  publisher: '대한침구의학회',
  version: '2.1',
  publishedAt: '2022-03-15',
  sourceUrl: 'https://nckm.example.org/guideline/shoulder',
  sections: [
    {
      path: ['1', '치료'],
      title: '치료',
      order: 1,
      chunks: [
        {
          content: '견비통 환자에게 침 치료와 부항 병행을 고려할 수 있다.',
          recommendationNumber: 'R1',
          recommendationGrade: { system: 'GRADE', code: 'B', label: '약한 권고' },
        },
      ],
    },
  ],
};
