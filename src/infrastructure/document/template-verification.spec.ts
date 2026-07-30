// docs/specs/20 수용 기준 13 동결 테스트 — 구현 중 수정 금지
import { type ChunkDiagnostics } from './guideline-chunker';
import {
  compareToExpectations,
  type TemplateActual,
  type TemplateExpectation,
} from './template-verification';

const diagnostics = (
  values: Partial<ChunkDiagnostics> & Pick<ChunkDiagnostics, 'uniqueNumbers'>,
): ChunkDiagnostics => ({
  uniqueNumbers: values.uniqueNumbers,
  missing: values.missing ?? [],
  duplicated: values.duplicated ?? [],
  gradeMissing: values.gradeMissing ?? [],
  unknownEvidenceLevels: values.unknownEvidenceLevels ?? [],
});

describe('spec 20: 지침 템플릿 일반화', () => {
  it('기준 13: 문서별 실제 산출이 알려진 OK·PARTIAL 기대치와 같으면 일치로 집계한다', () => {
    const actual: Record<string, TemplateActual> = {
      'known-ok': {
        diagnostics: diagnostics({ uniqueNumbers: ['R1', 'R2'] }),
        recommendations: 2,
      },
      'known-partial': {
        diagnostics: diagnostics({
          uniqueNumbers: ['R1', 'R2', 'R3'],
          missing: ['R3'],
        }),
        recommendations: 2,
      },
    };
    const expected: Record<string, TemplateExpectation> = {
      'known-ok': {
        uniqueNumbers: 2,
        recommendations: 2,
        status: 'OK',
      },
      'known-partial': {
        uniqueNumbers: 3,
        recommendations: 2,
        status: 'PARTIAL',
        unparsed: ['R3'],
      },
    };

    const report = compareToExpectations(actual, expected);

    expect(report.checked).toBe(2);
    expect(report.ok).toBe(1);
    expect(report.partial).toBe(1);
    expect(report.mismatches).toEqual([]);
    expect(report.unexpected).toEqual([]);
    expect(report.missingDocuments).toEqual([]);
  });

  it('기준 13: 건수·상태·미파싱 번호의 회귀와 개선 및 문서 집합 차이를 모두 보고한다', () => {
    const actual: Record<string, TemplateActual> = {
      regressed: {
        diagnostics: diagnostics({
          uniqueNumbers: ['R1', 'R2'],
          missing: ['R2'],
        }),
        recommendations: 1,
      },
      improved: {
        diagnostics: diagnostics({ uniqueNumbers: ['R1', 'R2', 'R3'] }),
        recommendations: 3,
      },
      'unique-count-changed': {
        diagnostics: diagnostics({ uniqueNumbers: ['R1', 'R2'] }),
        recommendations: 2,
      },
      'recommendation-count-changed': {
        diagnostics: diagnostics({ uniqueNumbers: ['R1', 'R2', 'R3'] }),
        recommendations: 2,
      },
      'partial-shift': {
        diagnostics: diagnostics({
          uniqueNumbers: ['R1', 'R2', 'R3'],
          missing: ['R2'],
        }),
        recommendations: 2,
      },
      unexpected: {
        diagnostics: diagnostics({ uniqueNumbers: ['R1'] }),
        recommendations: 1,
      },
    };
    const expected: Record<string, TemplateExpectation> = {
      regressed: {
        uniqueNumbers: 2,
        recommendations: 2,
        status: 'OK',
      },
      improved: {
        uniqueNumbers: 3,
        recommendations: 2,
        status: 'PARTIAL',
        unparsed: ['R3'],
      },
      'unique-count-changed': {
        uniqueNumbers: 3,
        recommendations: 2,
        status: 'OK',
      },
      'recommendation-count-changed': {
        uniqueNumbers: 3,
        recommendations: 3,
        status: 'OK',
      },
      'partial-shift': {
        uniqueNumbers: 3,
        recommendations: 2,
        status: 'PARTIAL',
        unparsed: ['R3'],
      },
      'not-downloaded': {
        uniqueNumbers: 2,
        recommendations: 2,
        status: 'OK',
      },
    };

    const report = compareToExpectations(actual, expected);
    const mismatchIds = [...new Set(report.mismatches.map(({ documentId }) => documentId))];
    const expectedMismatchIds = [
      'regressed',
      'improved',
      'unique-count-changed',
      'recommendation-count-changed',
      'partial-shift',
    ];

    expect(mismatchIds).toEqual(expect.arrayContaining(expectedMismatchIds));
    expectedMismatchIds.forEach((documentId) => {
      expect(
        report.mismatches.find((mismatch) => mismatch.documentId === documentId)?.reason,
      ).toEqual(expect.stringMatching(/\S/));
    });
    expect(report.unexpected).toEqual(['unexpected']);
    expect(report.missingDocuments).toEqual(['not-downloaded']);
  });
});
