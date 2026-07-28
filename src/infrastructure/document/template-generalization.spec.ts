// docs/specs/20 수용 기준 1~12 동결 테스트 — 구현 중 수정 금지
import {
  type GuidelineIngestInput,
  type IngestChunk,
} from '../../domain/guideline/service/guideline-ingest.input';
import {
  familyAPages,
  familyBPages,
  familyCPages,
  gradeSpacingPages,
  noMarkerPages,
} from '../../../test/fixtures/nckm-template-samples';
import {
  chunkNckmGuidelineWithDiagnostics,
  type GuidelineDocumentMeta,
} from './guideline-chunker';

const meta: GuidelineDocumentMeta = {
  title: '별무리 증후군 한의표준임상진료지침',
  publisher: '가상한의연구원',
  version: '2026-07',
  publishedAt: '2026-07-01',
  sourceUrl: 'https://guidelines.example.test/constellation-syndrome',
};

interface LocatedChunk {
  sectionPath: string[];
  chunk: IngestChunk;
}

const flattenChunks = (input: GuidelineIngestInput): LocatedChunk[] =>
  input.sections.flatMap((section) =>
    section.chunks.map((chunk) => ({ sectionPath: section.path, chunk })),
  );

/**
 * 등급 추출에 실패해도 권고문 청크는 존재한다. 같은 번호의 첫 청크를 권고문으로 보는 §20 계약을 따른다.
 */
const firstRecommendations = (input: GuidelineIngestInput): LocatedChunk[] => {
  const seen = new Set<string>();

  return flattenChunks(input).filter(({ chunk }) => {
    const number = chunk.recommendationNumber;
    if (number === undefined || seen.has(number)) return false;
    seen.add(number);
    return true;
  });
};

const findRecommendation = (
  input: GuidelineIngestInput,
  recommendationNumber: string,
): LocatedChunk | undefined =>
  firstRecommendations(input).find(
    ({ chunk }) => chunk.recommendationNumber === recommendationNumber,
  );

const recommendationNumbers = (input: GuidelineIngestInput): string[] =>
  firstRecommendations(input).map(({ chunk }) => chunk.recommendationNumber as string);

const sorted = (values: string[]): string[] => [...values].sort();

describe('spec 20: 지침 템플릿 일반화', () => {
  it('기준 1: 고유 권고 번호별 권고문을 만들고 청크가 없는 번호를 missing으로 진단한다', () => {
    const pages = [
      ...familyAPages,
      `58
IV 권고사항
【 R9 】
이 번호는 요약문에서 언급되었지만 뒤에 권고 표나 등급이 없다.`,
    ];
    const result = chunkNckmGuidelineWithDiagnostics(pages, meta);

    expect(sorted(result.diagnostics.uniqueNumbers)).toEqual(['R1', 'R2', 'R9']);
    expect(recommendationNumbers(result.input)).toEqual(['R1', 'R2']);
    expect(result.diagnostics.missing).toEqual(['R9']);
    expect(result.diagnostics.duplicated).toEqual([]);
  });

  it('기준 2: 같은 번호의 유효 블록이 둘이면 duplicated로 진단한다', () => {
    const duplicatedPages = familyAPages.map((page) =>
      page.replace('【 R2 】', '【 R1 】'),
    );
    const result = chunkNckmGuidelineWithDiagnostics(duplicatedPages, meta);

    expect(result.diagnostics.uniqueNumbers).toEqual(['R1']);
    expect(result.diagnostics.duplicated).toEqual(['R1']);
  });

  it('기준 3: 마커가 전혀 없는 문서는 고유 번호가 0개인 것으로 진단한다', () => {
    const supported = chunkNckmGuidelineWithDiagnostics(familyAPages, meta);
    const noMarkers = chunkNckmGuidelineWithDiagnostics(noMarkerPages, meta);

    // 빈 배열 단언만으로 스텁이 통과하지 않도록 먼저 마커 검출의 양성 대조군을 둔다.
    expect(supported.diagnostics.uniqueNumbers).toEqual(['R1', 'R2']);
    expect(noMarkers.diagnostics.uniqueNumbers).toEqual([]);
    expect(flattenChunks(noMarkers.input)).toHaveLength(0);
  });

  it('기준 4: 권고문은 있으나 등급을 추출하지 못한 번호를 gradeMissing으로 진단한다', () => {
    const gradeMissingPages = familyAPages.map((page) =>
      page.replace(/A\/High|B\/Low/g, '등급 미기재'),
    );
    const result = chunkNckmGuidelineWithDiagnostics(gradeMissingPages, meta);

    expect(result.diagnostics.uniqueNumbers).toEqual(['R1', 'R2']);
    expect(recommendationNumbers(result.input)).toEqual(['R1', 'R2']);
    expect(result.diagnostics.gradeMissing).toEqual(['R1', 'R2']);
  });

  it('기준 5: 표 안의 마커 재인용은 새 블록으로 세지 않는다', () => {
    const result = chunkNckmGuidelineWithDiagnostics(familyBPages, meta);

    expect(recommendationNumbers(result.input)).toEqual(['R1', 'R2']);
    expect(result.diagnostics.uniqueNumbers).toEqual(['R1', 'R2']);
    expect(result.diagnostics.duplicated).toEqual([]);
  });

  it('기준 6: ASCII와 전각 로마 숫자 장 헤더를 같은 경로로 정규화한다', () => {
    const familyA = chunkNckmGuidelineWithDiagnostics(familyAPages, meta);
    const familyB = chunkNckmGuidelineWithDiagnostics(familyBPages, meta);

    expect(findRecommendation(familyA.input, 'R1')?.sectionPath[0]).toBe(
      'Ⅳ. 권고사항',
    );
    expect(findRecommendation(familyB.input, 'R1')?.sectionPath[0]).toBe(
      'Ⅳ. 권고사항',
    );
  });

  it('기준 7: 러닝 타이틀이 붙은 첫 줄에서 인쇄 번호를 읽고 그 페이지 본문을 포함한다', () => {
    const result = chunkNckmGuidelineWithDiagnostics(familyBPages, meta);
    const r1 = findRecommendation(result.input, 'R1');

    expect(r1?.chunk).toMatchObject({
      recommendationNumber: 'R1',
      pageStart: 54,
      pageEnd: 54,
    });
    expect(r1?.chunk.content).toContain(
      '유리별 과민 증상이 있는 성인은 유리별 자극을 우선 적용할 것을 권고한다.',
    );
  });

  it('기준 8: 장 러닝 헤더가 없는 문서도 관측된 절 헤더만으로 경로를 만든다', () => {
    const result = chunkNckmGuidelineWithDiagnostics(familyCPages, meta);

    expect(recommendationNumbers(result.input)).toEqual(['R1', 'R2']);
    expect(findRecommendation(result.input, 'R1')?.sectionPath).toEqual([
      expect.stringContaining('한의단독치료'),
      '1) 달빛 호흡법',
    ]);
    expect(findRecommendation(result.input, 'R2')?.sectionPath).toEqual([
      '1. 한의복합치료',
    ]);
  });

  it('기준 9: 슬래시 둘레의 공백과 무관하게 권고등급과 근거수준을 분리한다', () => {
    const result = chunkNckmGuidelineWithDiagnostics(gradeSpacingPages, meta);
    const r1 = findRecommendation(result.input, 'R1');
    const r2 = findRecommendation(result.input, 'R2');

    expect(r1?.chunk).toMatchObject({
      recommendationGrade: {
        system: 'GRADE',
        code: 'A',
        label: '강한 권고',
      },
      evidenceLevel: {
        system: 'GRADE',
        code: 'Moderate',
        label: '중등도',
      },
    });
    expect(r2?.chunk).toMatchObject({
      recommendationGrade: {
        system: 'GRADE',
        code: 'C',
        label: '약한 권고',
      },
      evidenceLevel: {
        system: 'GRADE',
        code: 'Very Low',
        label: '매우 낮음',
      },
    });
  });

  it('기준 10: 마커 뒤에 붙은 제목을 제외하고 권고 번호와 권고문을 추출한다', () => {
    const result = chunkNckmGuidelineWithDiagnostics(familyCPages, meta);
    const r1 = findRecommendation(result.input, 'R1');

    expect(r1?.chunk).toMatchObject({ recommendationNumber: 'R1' });
    expect(r1?.chunk.content).toBe(
      [
        '안개성 피로가 있는 성인은 달빛 호흡법을 적용할 것을 권고한다.',
        '임상적 고려사항',
        '어지럼이 있으면 시간을 줄인다.',
      ].join('\n'),
    );
  });

  it('기준 11: 컬럼 구성이 다른 표 헤더를 권고문 content에서 제외한다', () => {
    const result = chunkNckmGuidelineWithDiagnostics(familyCPages, meta);
    const r2 = findRecommendation(result.input, 'R2');

    expect(r2?.chunk.content).toBe(
      [
        '별가루 불면이 지속되면 구름북 이완법을 함께 적용할 것을 권고한다.',
        '임상적 고려사항',
        '졸림이 심하면 시행 횟수를 줄인다.',
      ].join('\n'),
    );
    expect(r2?.chunk.content).not.toContain(
      '권고안 번호 권고내용 권고등급/근거수준',
    );
  });

  it('기준 12: 기호·마침표 절 헤더에도 경로 상속과 하위 레벨 초기화를 적용한다', () => {
    const familyB = chunkNckmGuidelineWithDiagnostics(familyBPages, meta);
    const familyC = chunkNckmGuidelineWithDiagnostics(familyCPages, meta);

    expect(findRecommendation(familyB.input, 'R1')?.sectionPath).toEqual([
      'Ⅳ. 권고사항',
      expect.stringContaining('한의단독치료'),
      expect.stringContaining('유리별 자극'),
    ]);
    expect(findRecommendation(familyB.input, 'R2')?.sectionPath).toEqual([
      'Ⅳ. 권고사항',
      expect.stringContaining('한의단독치료'),
      expect.stringContaining('유리별 자극'),
    ]);
    expect(findRecommendation(familyC.input, 'R1')?.sectionPath).toEqual([
      expect.stringContaining('한의단독치료'),
      '1) 달빛 호흡법',
    ]);
    expect(findRecommendation(familyC.input, 'R2')?.sectionPath).toEqual([
      '1. 한의복합치료',
    ]);
  });
});
