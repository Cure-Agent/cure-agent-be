// docs/specs/33 수용 기준 2 동결 테스트 — 구현 중 수정 금지

import type { AnswerCitationResponseDto } from '../../conversation/dto/response/answer-citation.response.dto';
import type {
  GuidanceStructureResult,
  StructuredConsideration,
} from '../../../infrastructure/llm/guidance/guidance-structurer.port';
import { validateStructuredConsiderations } from './guidance-consideration.validator';

const citation = (marker: number): AnswerCitationResponseDto => ({
  marker,
  evidenceId: 'evidence-' + marker,
  guidelineTitle: '요통 진료지침',
  guidelineVersion: '1.0',
  sectionPath: ['치료', '침치료'],
  quote: marker + '번 근거 원문',
  sourceUrl: 'https://example.test/guidelines/' + marker,
});

const citations = [citation(1), citation(2)];
const profileFields = [
  { field: '진단명', value: '고혈압' },
  { field: '임상 메모', value: '임신 8주' },
];

const consideration = (
  overrides: Partial<StructuredConsideration> = {},
): StructuredConsideration => ({
  title: '환자 상태와 근거의 적용 판단',
  rationale: '근거의 조건을 환자의 진단명과 대조했습니다.',
  applicability: 'APPLICABLE',
  markers: [1],
  patientFactors: ['진단명'],
  ...overrides,
});

const validate = (
  considerations: StructuredConsideration[],
  answerCitations: AnswerCitationResponseDto[] = citations,
) =>
  validateStructuredConsiderations({
    structured: { considerations } satisfies GuidanceStructureResult,
    citations: answerCitations,
    profileFields,
  });

describe('spec 33: 구조화 consideration 결정적 검증기', () => {
  it('기준 2a: 답변 인용에 없는 마커가 섞인 항목을 폐기한다', () => {
    const result = validate([consideration({ markers: [1, 999] })]);

    expect(result).toEqual([]);
  });

  it('기준 2b: 값이 채워진 프로필 필드에 없는 필드명이 섞인 항목을 폐기한다', () => {
    const result = validate([
      consideration({
        patientFactors: ['진단명', '알레르기 이력'],
      }),
    ]);

    expect(result).toEqual([]);
  });

  it('기준 2c: 세 가지 허용값 밖의 applicability를 폐기한다', () => {
    expect(validate([consideration({ applicability: 'MAYBE' })])).toEqual([]);
    expect(validate([consideration({ applicability: '' })])).toEqual([]);
  });

  it('기준 2d: markers가 빈 배열인 항목을 폐기한다', () => {
    const result = validate([consideration({ markers: [] })]);

    expect(result).toEqual([]);
  });

  it('기준 2e: patientFactors가 빈 배열인 항목을 폐기한다', () => {
    const result = validate([consideration({ patientFactors: [] })]);

    expect(result).toEqual([]);
  });

  it('기준 2f-1: title이 빈 문자열이거나 공백뿐인 항목을 폐기한다', () => {
    expect(validate([consideration({ title: '' })])).toEqual([]);
    expect(validate([consideration({ title: '   ' })])).toEqual([]);
  });

  it('기준 2f-2: rationale이 빈 문자열이거나 공백뿐인 항목을 폐기한다', () => {
    expect(validate([consideration({ rationale: '' })])).toEqual([]);
    expect(validate([consideration({ rationale: '   ' })])).toEqual([]);
  });

  it('기준 2g: 유효 항목과 무효 항목이 섞이면 유효한 항목 하나만 내용 그대로 남긴다', () => {
    const valid = consideration({
      title: '남아야 하는 항목',
      rationale: '유효한 두 다리를 모두 명시했습니다.',
      applicability: 'CAUTION',
      markers: [2],
      patientFactors: ['임상 메모'],
    });
    const invalid = consideration({
      title: '폐기되어야 하는 항목',
      markers: [777],
    });

    const result = validate([invalid, valid]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: '남아야 하는 항목',
      rationale: '유효한 두 다리를 모두 명시했습니다.',
      applicability: 'CAUTION',
      patientFactors: ['임상 메모'],
    });
    expect(result[0].citations.map((item) => item.marker)).toEqual([2]);
  });

  it('기준 2h: 모든 항목이 폐기되면 폴백 신호인 빈 배열을 반환한다', () => {
    const result = validate([
      consideration({ markers: [] }),
      consideration({ patientFactors: ['체중'] }),
      consideration({ applicability: 'UNKNOWN' }),
    ]);

    expect(result).toEqual([]);
  });

  it('기준 2i: 통과 항목에 모든 marker의 인용을 싣고 적용값과 환자 필드를 보존한다', () => {
    const result = validate([
      consideration({
        title: '두 근거 적용 판단',
        applicability: 'NOT_APPLICABLE',
        markers: [2, 1],
        patientFactors: ['진단명', '임상 메모'],
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].citations).toHaveLength(2);
    expect(
      result[0].citations.map((item) => item.marker).sort((a, b) => a - b),
    ).toEqual([1, 2]);
    expect(result[0].applicability).toBe('NOT_APPLICABLE');
    expect(result[0].patientFactors).toEqual(['진단명', '임상 메모']);
  });
});
