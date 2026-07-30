// docs/specs/23 수용 기준 1~8 동결 테스트 — 구현 중 수정 금지
import {
  type GuidelineIngestInput,
  type IngestChunk,
} from '../../domain/guideline/service/guideline-ingest.input';
import {
  consensusRecommendationPages,
  dottedGradePages,
  extendedGradeVocabularyPages,
  hyphenatedRecommendationPages,
  postSubsectionReferencePages,
  preSubsectionMissingPages,
  unknownEvidenceLevelPages,
  unsupportedRecitationPages,
} from '../../../test/fixtures/nckm-residual-samples';
import {
  chunkNckmGuideline,
  type GuidelineDocumentMeta,
} from './guideline-chunker';

const meta: GuidelineDocumentMeta = {
  title: '별바람 증후군 한의표준임상진료지침',
  publisher: '가상별빛연구원',
  version: '2026-07',
  publishedAt: '2026-07-01',
  sourceUrl: 'https://guidelines.example.test/star-wind-syndrome',
};

interface LocatedChunk {
  sectionPath: string[];
  chunk: IngestChunk;
}

const flattenChunks = (input: GuidelineIngestInput): LocatedChunk[] =>
  input.sections.flatMap((section) =>
    section.chunks.map((chunk) => ({ sectionPath: section.path, chunk })),
  );

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

describe('spec 23: 잔여 템플릿 일반화', () => {
  it('기준 1: 합의를 통해 권고한다로 끝나는 문장은 표와 등급이 없어도 GPP 권고 블록이다', () => {
    const result = chunkNckmGuideline(consensusRecommendationPages, meta);
    const r20 = findRecommendation(result.input, 'R20');
    const r21 = findRecommendation(result.input, 'R21');

    expect(recommendationNumbers(result.input)).toEqual(['R20', 'R21']);
    expect(r20?.chunk.recommendationGrade).toMatchObject({
      system: 'GRADE',
      code: 'GPP',
      label: '전문가 합의 권고',
    });
    expect(r20?.chunk.evidenceLevel).toBeUndefined();
    expect(r21?.chunk.recommendationGrade).toMatchObject({
      system: 'GRADE',
      code: 'GPP',
      label: '전문가 합의 권고',
    });
    expect(r21?.chunk.evidenceLevel).toBeUndefined();

    // 마커 줄의 텍스트를 제목처럼 버리면 content가 뒤의 합의 문구부터 시작하는 회귀를 잡는다.
    expect(r20?.chunk.content).toMatch(
      /^작은별 식욕 저하에는 별씨 간식을 나누어 먹는 방식을/,
    );
    expect(r20?.chunk.content).toContain('합의를 통해 권고한다.');
    expect(r21?.chunk.content).toContain(
      '밤안개성 갈증에는 구름샘 음료를 소량 제공하도록 합의를 통해 권고한다.',
    );
    expect(result.diagnostics.gradeMissing).toEqual([]);
  });

  it('기준 2: 합의 문구와 표 헤더와 등급이 모두 없는 마커는 권고 블록이 아니다', () => {
    const result = chunkNckmGuideline(unsupportedRecitationPages, meta);

    expect(recommendationNumbers(result.input)).toEqual(['R1']);
    expect(result.diagnostics.uniqueNumbers).toEqual(['R1']);
    expect(result.diagnostics.duplicated).toEqual([]);
  });

  it('기준 3: 소절 마커 뒤의 비블록 권고 번호 재인용은 uniqueNumbers에서 제외한다', () => {
    const result = chunkNckmGuideline(postSubsectionReferencePages, meta);

    expect(result.diagnostics.uniqueNumbers).toEqual(['R3']);
    expect(recommendationNumbers(result.input)).toEqual(['R3']);
    expect(result.diagnostics.missing).toEqual([]);
    expect(findRecommendation(result.input, 'R88')).toBeUndefined();
  });

  it('기준 4: 소절 시작 전의 비블록 마커는 uniqueNumbers와 missing에 남는다', () => {
    const result = chunkNckmGuideline(preSubsectionMissingPages, meta);

    // R89는 소절 전에, R90은 소절 뒤에 있다. 배제 규칙이 R89의 미검출을 덮어서는 안 된다.
    expect(sorted(result.diagnostics.uniqueNumbers)).toEqual(['R4', 'R89']);
    expect(result.diagnostics.missing).toEqual(['R89']);
    expect(findRecommendation(result.input, 'R89')).toBeUndefined();
    expect(findRecommendation(result.input, 'R90')).toBeUndefined();
  });

  it('기준 5: 하이픈 하위번호도 표 헤더와 등급이 있으면 정상 권고 블록이다', () => {
    const result = chunkNckmGuideline(hyphenatedRecommendationPages, meta);
    const recommendation = findRecommendation(result.input, 'R5-1');

    expect(result.diagnostics.uniqueNumbers).toEqual(['R5-1']);
    expect(recommendation?.chunk).toMatchObject({
      recommendationNumber: 'R5-1',
      recommendationGrade: { code: 'B' },
      evidenceLevel: { code: 'Moderate' },
    });
    expect(result.diagnostics.missing).toEqual([]);
    expect(result.diagnostics.gradeMissing).toEqual([]);
  });

  it('기준 6: Inconclusive와 Insufficient를 원문이 정한 등급 축으로 읽는다', () => {
    const result = chunkNckmGuideline(extendedGradeVocabularyPages, meta);
    const inconclusive = findRecommendation(result.input, 'R6');
    const evidenceFirst = findRecommendation(result.input, 'R7');
    const gradeFirst = findRecommendation(result.input, 'R8');

    expect(inconclusive?.chunk.recommendationGrade).toMatchObject({
      code: 'Inconclusive',
    });
    expect(inconclusive?.chunk.evidenceLevel).toBeUndefined();

    for (const recommendation of [evidenceFirst, gradeFirst]) {
      expect(recommendation?.chunk.recommendationGrade).toMatchObject({
        code: 'GPP',
      });
      expect(recommendation?.chunk.evidenceLevel).toMatchObject({
        code: 'Insufficient',
      });
    }

    expect(result.diagnostics.gradeMissing).toEqual([]);
    expect(result.diagnostics.unknownEvidenceLevels).toEqual([]);
  });

  it('기준 7: 등급 문자 뒤 마침표를 제거해 C./Very Low와 C/Very Low를 같게 읽는다', () => {
    const result = chunkNckmGuideline(dottedGradePages, meta);
    const dotted = findRecommendation(result.input, 'R9');
    const canonical = findRecommendation(result.input, 'R10');

    expect(dotted?.chunk.recommendationGrade).toMatchObject({ code: 'C' });
    expect(dotted?.chunk.evidenceLevel).toMatchObject({ code: 'Very Low' });
    expect(dotted?.chunk.recommendationGrade).toEqual(
      canonical?.chunk.recommendationGrade,
    );
    expect(dotted?.chunk.evidenceLevel).toEqual(canonical?.chunk.evidenceLevel);
    expect(result.diagnostics.gradeMissing).toEqual([]);
  });

  it('기준 8: 등급 문자가 인식되면 미상 근거수준을 보고하고 gradeMissing으로 보지 않는다', () => {
    const result = chunkNckmGuideline(unknownEvidenceLevelPages, meta);
    const recommendation = findRecommendation(result.input, 'R11');

    expect(recommendation?.chunk.recommendationGrade).toMatchObject({ code: 'C' });
    expect(recommendation?.chunk.evidenceLevel).toBeUndefined();
    expect(result.diagnostics.gradeMissing).toEqual([]);
    expect(result.diagnostics.unknownEvidenceLevels).toEqual([
      { recommendationNumber: 'R11', raw: 'Vey Low' },
    ]);
  });
});
