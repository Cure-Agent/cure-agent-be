// docs/specs/24 수용 기준 1~9 동결 테스트 — 구현 중 수정 금지
import {
  type GuidelineIngestInput,
  type IngestChunk,
} from '../../domain/guideline/service/guideline-ingest.input';
import {
  acceptedBlockWithNotDerivedPhrasePages,
  bareInlineMarkerPages,
  bareStandaloneMarkerPages,
  bracketedMarkerWithBareRecitationPages,
  fullWidthRomanCoordinatePages,
  lowercaseSuffixCoordinatePages,
  multiHyphenCoordinatePages,
  notDerivedThenNormalBlocksPages,
  parenthesizedCoordinatePages,
  spacedHeaderAfterMarkerPages,
  wrappedNotDerivedPages,
} from '../../../test/fixtures/nckm-ingest-target-samples';
import {
  chunkNckmGuideline,
  containsRecommendationMarker,
  type GuidelineDocumentMeta,
} from './guideline-chunker';

const meta: GuidelineDocumentMeta = {
  title: '별구름 증후군 한의표준임상진료지침',
  publisher: '가상은하연구원',
  version: '2026-07',
  publishedAt: '2026-07-01',
  sourceUrl: 'https://guidelines.example.test/star-cloud-syndrome',
};

interface LocatedChunk {
  sectionPath: string[];
  chunk: IngestChunk;
}

const flattenChunks = (input: GuidelineIngestInput): LocatedChunk[] =>
  input.sections.flatMap((section) =>
    section.chunks.map((chunk) => ({ sectionPath: section.path, chunk })),
  );

const recommendationChunks = (input: GuidelineIngestInput): LocatedChunk[] =>
  flattenChunks(input).filter(
    ({ chunk }) => chunk.recommendationNumber !== undefined,
  );

const firstRecommendations = (input: GuidelineIngestInput): LocatedChunk[] => {
  const seen = new Set<string>();

  return recommendationChunks(input).filter(({ chunk }) => {
    const number = chunk.recommendationNumber as string;
    if (seen.has(number)) return false;
    seen.add(number);
    return true;
  });
};

const recommendationNumbers = (input: GuidelineIngestInput): string[] =>
  firstRecommendations(input).map(
    ({ chunk }) => chunk.recommendationNumber as string,
  );

const findRecommendation = (
  input: GuidelineIngestInput,
  recommendationNumber: string,
): LocatedChunk | undefined =>
  firstRecommendations(input).find(
    ({ chunk }) => chunk.recommendationNumber === recommendationNumber,
  );

const countRecommendationChunks = (
  input: GuidelineIngestInput,
  recommendationNumber: string,
): number =>
  recommendationChunks(input).filter(
    ({ chunk }) => chunk.recommendationNumber === recommendationNumber,
  ).length;

/**
 * 기준 7의 가드가 기존의 "괄호 없는 마커를 전혀 읽지 않음"으로 우연히 통과하지 않도록,
 * 문서에 전각 괄호 마커가 없을 때의 fallback 자체가 활성화되었음을 함께 확인한다.
 */
const expectBareMarkerFallbackActive = (): void => {
  const fallback = chunkNckmGuideline(bareInlineMarkerPages, meta);
  expect(recommendationNumbers(fallback.input)).toContain('R1');
};

describe('spec 24: 인제스트 대상 마커 문법', () => {
  it('기준 1a: 괄호 복합 좌표 마커를 권고 블록 하나로 인식한다', () => {
    const result = chunkNckmGuideline(parenthesizedCoordinatePages, meta);

    expect(
      countRecommendationChunks(result.input, 'R(Ⅰ-A-1)'),
    ).toBe(1);
  });

  it('기준 1b: 괄호 복합 좌표의 원문 표기를 recommendationNumber에 보존한다', () => {
    const result = chunkNckmGuideline(parenthesizedCoordinatePages, meta);
    const recommendation = firstRecommendations(result.input)[0];

    expect(recommendation?.chunk.recommendationNumber).toBe('R(Ⅰ-A-1)');
  });

  it('기준 2a: 전각 로마숫자 좌표 R(Ⅲ-B-2)를 인식한다', () => {
    const result = chunkNckmGuideline(fullWidthRomanCoordinatePages, meta);

    expect(recommendationNumbers(result.input)).toContain('R(Ⅲ-B-2)');
  });

  it('기준 2b: 소문자 접미 좌표 R(Ⅲc-E-3)를 인식한다', () => {
    const result = chunkNckmGuideline(lowercaseSuffixCoordinatePages, meta);

    expect(recommendationNumbers(result.input)).toContain('R(Ⅲc-E-3)');
  });

  it('기준 2c: 다단 하이픈 좌표 R(Ⅱa-B-1-1)를 인식한다', () => {
    const result = chunkNckmGuideline(multiHyphenCoordinatePages, meta);

    expect(recommendationNumbers(result.input)).toContain('R(Ⅱa-B-1-1)');
  });

  it('기준 3a: 번호·권고내용 컬럼이 없는 표 헤더를 content에서 제외한다', () => {
    const result = chunkNckmGuideline(parenthesizedCoordinatePages, meta);
    const recommendation = findRecommendation(result.input, 'R(Ⅰ-A-1)');

    expect(recommendation).toBeDefined();
    expect(recommendation?.chunk.content).not.toContain(
      '권고안 권고등급/근거수준 참고문헌',
    );
  });

  it('기준 3b: 번호·권고내용 컬럼이 없는 표에서도 B/Moderate 등급을 추출한다', () => {
    const result = chunkNckmGuideline(parenthesizedCoordinatePages, meta);
    const recommendation = findRecommendation(result.input, 'R(Ⅰ-A-1)');

    expect(recommendation?.chunk).toMatchObject({
      recommendationGrade: { code: 'B' },
      evidenceLevel: { code: 'Moderate' },
    });
    expect(result.diagnostics.gradeMissing).toEqual([]);
  });

  it('기준 4a: 블록이 아닌 비도출 마커 번호를 uniqueNumbers에서 제외한다', () => {
    const result = chunkNckmGuideline(wrappedNotDerivedPages, meta);

    expect(findRecommendation(result.input, 'R(Ⅲa-D-11)')).toBeUndefined();
    expect(result.diagnostics.uniqueNumbers).not.toContain('R(Ⅲa-D-11)');
    // 빈 진단을 내는 기존 구현의 우연한 통과를 막는 비공허성 가드다.
    expect(containsRecommendationMarker(wrappedNotDerivedPages)).toBe(true);
  });

  it('기준 4b: 블록이 아닌 비도출 마커 번호를 missing으로 오인하지 않는다', () => {
    const result = chunkNckmGuideline(wrappedNotDerivedPages, meta);

    expect(result.diagnostics.missing).not.toContain('R(Ⅲa-D-11)');
    // 마커를 애초에 못 본 빈 진단과 비도출 판정을 구분한다.
    expect(containsRecommendationMarker(wrappedNotDerivedPages)).toBe(true);
  });

  it('기준 4c: 줄바꿈으로 갈린 비도출 문구를 공백 제거 후 인식한다', () => {
    const result = chunkNckmGuideline(wrappedNotDerivedPages, meta);

    expect(result.diagnostics.notDerived).toContain('R(Ⅲa-D-11)');
    expect(result.diagnostics.uniqueNumbers).not.toContain('R(Ⅲa-D-11)');
  });

  it('기준 5a: 제외한 권고 번호를 notDerived 진단에 담는다', () => {
    const result = chunkNckmGuideline(wrappedNotDerivedPages, meta);

    expect(result.diagnostics.notDerived).toEqual(['R(Ⅲa-D-11)']);
  });

  it('기준 5b: 정상 블록 해설의 비도출 문구는 배제하지 않는다', () => {
    const result = chunkNckmGuideline(
      acceptedBlockWithNotDerivedPhrasePages,
      meta,
    );

    expect(result.diagnostics.uniqueNumbers).toContain('R(Ⅰ-A-2)');
    expect(findRecommendation(result.input, 'R(Ⅰ-A-2)')).toBeDefined();
    expect(result.diagnostics.notDerived).toEqual([]);
  });

  it('기준 5c: 비도출 번호 뒤의 정상 권고 블록들을 모두 보존한다', () => {
    const result = chunkNckmGuideline(notDerivedThenNormalBlocksPages, meta);

    expect(recommendationNumbers(result.input)).toEqual([
      'R(Ⅰ-A-1)',
      'R(Ⅲc-E-3)',
    ]);
    expect(recommendationChunks(result.input)).toHaveLength(2);
    expect(result.diagnostics.notDerived).toEqual(['R(Ⅲa-D-11)']);
    expect(result.diagnostics.missing).toEqual([]);
  });

  it('기준 6a: 전각 괄호 마커가 없는 문서의 줄머리 R1을 블록 마커로 인식한다', () => {
    expect(containsRecommendationMarker(bareInlineMarkerPages)).toBe(true);

    const result = chunkNckmGuideline(bareInlineMarkerPages, meta);
    expect(findRecommendation(result.input, 'R1')).toBeDefined();
  });

  it('기준 6b: 괄호 없는 마커의 recommendationNumber를 R1로 보존한다', () => {
    const result = chunkNckmGuideline(bareInlineMarkerPages, meta);

    expect(
      findRecommendation(result.input, 'R1')?.chunk.recommendationNumber,
    ).toBe('R1');
  });

  it('기준 7a: 전각 괄호 마커 문서의 앞쪽 괄호 없는 R1 재수록을 별도 블록으로 보지 않는다', () => {
    const result = chunkNckmGuideline(
      bracketedMarkerWithBareRecitationPages,
      meta,
    );

    expect(countRecommendationChunks(result.input, 'R1')).toBe(1);
    expect(findRecommendation(result.input, 'R1')?.chunk.content).toContain(
      '구름샘성 피로에는 별씨 휴식법을',
    );
    expectBareMarkerFallbackActive();
  });

  it('기준 7b: 괄호 없는 R1 재수록 때문에 duplicated 진단을 만들지 않는다', () => {
    const result = chunkNckmGuideline(
      bracketedMarkerWithBareRecitationPages,
      meta,
    );

    expect(result.diagnostics.duplicated).toEqual([]);
    expectBareMarkerFallbackActive();
  });

  it('기준 8a: 괄호 없는 마커 줄에 이어진 권고문을 content에 포함한다', () => {
    const result = chunkNckmGuideline(bareInlineMarkerPages, meta);
    const recommendation = findRecommendation(result.input, 'R1');

    expect(recommendation).toBeDefined();
    expect(recommendation?.chunk.content).toMatch(
      /^별가루성 피로에는 달그늘 휴식법을 적용할 것을 고려한다\./,
    );
  });

  it('기준 8b: 괄호 없는 마커가 단독 줄이면 다음 줄부터 content로 삼고 R2를 남기지 않는다', () => {
    const result = chunkNckmGuideline(bareStandaloneMarkerPages, meta);
    const recommendation = findRecommendation(result.input, 'R2');

    expect(recommendation).toBeDefined();
    expect(recommendation?.chunk.content).toMatch(
      /^밤안개성 긴장에는 은종 이완법을 적용할 것을 고려한다\./,
    );
    expect(recommendation?.chunk.content).not.toMatch(
      /(^|\n)\s*R2\s*(\n|$)/,
    );
  });

  it('기준 9a: 권고 내용에 어절 공백이 있고 참고문헌이 붙은 표 헤더를 content에서 제외한다', () => {
    const result = chunkNckmGuideline(spacedHeaderAfterMarkerPages, meta);
    const recommendation = findRecommendation(result.input, 'R3');

    expect(recommendation).toBeDefined();
    expect(recommendation?.chunk.content).not.toContain(
      '권고안 번호 권고 내용 권고등급/근거수준 참고문헌',
    );
  });

  it('기준 9b: 마커 앞에 놓인 표 헤더를 건너뛰고 블록과 등급을 추출한다', () => {
    const result = chunkNckmGuideline(bareInlineMarkerPages, meta);
    const recommendation = findRecommendation(result.input, 'R1');

    expect(recommendation?.chunk).toMatchObject({
      recommendationNumber: 'R1',
      recommendationGrade: { code: 'B' },
      evidenceLevel: { code: 'Moderate' },
    });
    expect(recommendation?.chunk.content).toContain(
      '별가루성 피로에는 달그늘 휴식법을',
    );
    expect(result.diagnostics.gradeMissing).toEqual([]);
  });
});
