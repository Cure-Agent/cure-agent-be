import type { GuidelineIngestInput } from '../../src/domain/guideline/service/guideline-ingest.input';

/** 원문과 120자 인용 발췌를 구별하는 순수 합성 자료다. */
export const compositeGuidanceSample: GuidelineIngestInput = {
  title: 'Spec54 합성 중재 검토 지침',
  publisher: '합성 테스트 발행기관',
  version: 'spec54-v1',
  publishedAt: '2026-01-01',
  sourceUrl: 'https://spec54.example.test/synthetic-guidance',
  sections: [
    {
      path: ['합성 장 A', '기록 대조', '검토 조건'],
      title: '합성 기록 대조',
      order: 1,
      chunks: [{
        content: '합성 근거 A: 이 문장은 소프트웨어 수용 테스트를 위한 가상 자료이며 실제 환자나 임상 권고를 나타내지 않는다. 기록에 담긴 조건과 중재 검토 항목을 대조하고 확인되지 않은 사항은 검토자에게 남긴다. 원문 전체 전달 여부를 구별하기 위해 발췌 경계를 넘는 뒷부분에도 고유한 내용을 둔다. 끝부분 식별자: 합성원문알파.',
        pageStart: 1,
        pageEnd: 2,
      }],
    },
    {
      path: ['합성 장 B', '추가 확인'],
      title: '합성 추가 확인',
      order: 2,
      chunks: [{
        content: '합성 근거 B: 이 가상 문단은 다른 절에 속한 근거의 연결 관계를 검사하기 위해 작성되었다. 환자 기록의 값이 있는 필드와 근거의 조건을 함께 읽고 적용 판단의 이유를 검토 대상으로 남긴다. 이 내용은 의학적 지시가 아니며 테스트 데이터의 구조만 재현한다. 짧은 인용 발췌에서는 사라지는 마지막 문장을 보존해야 한다. 끝부분 식별자: 합성원문베타.',
        pageStart: 3,
        pageEnd: 4,
      }],
    },
  ],
};
