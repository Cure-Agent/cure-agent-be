// docs/specs/24 수용 기준 5d~5e·15~17 동결 테스트 — 구현 중 수정 금지
import { type ChunkDiagnostics } from './guideline-chunker';
import {
  compareToExpectations,
  type TemplateActual,
  type TemplateExpectation,
  type VerificationReport,
} from './template-verification';

const diagnostics = (
  values: Partial<ChunkDiagnostics> & Pick<ChunkDiagnostics, 'uniqueNumbers'>,
): ChunkDiagnostics => ({
  uniqueNumbers: values.uniqueNumbers,
  missing: values.missing ?? [],
  duplicated: values.duplicated ?? [],
  gradeMissing: values.gradeMissing ?? [],
  unknownEvidenceLevels: values.unknownEvidenceLevels ?? [],
  notDerived: values.notDerived ?? [],
});

const expectMismatch = (
  report: VerificationReport,
  documentId: string,
): void => {
  expect(
    report.mismatches.some(
      (mismatch) =>
        mismatch.documentId === documentId && /\S/.test(mismatch.reason),
    ),
  ).toBe(true);
};

const expectNotTargetComparisonActive = (): void => {
  const report = compareToExpectations(
    {
      'not-target-activation-guard': {
        diagnostics: diagnostics({ uniqueNumbers: [] }),
        recommendations: 0,
      },
    },
    {
      'not-target-activation-guard': {
        uniqueNumbers: 0,
        recommendations: 0,
        status: 'NOT_TARGET',
      },
    },
    ['not-target-activation-guard'],
  );

  expect(report.notTarget).toBe(1);
};

describe('spec 24: NOT_TARGET 기대치 대조', () => {
  it('기준 15a: NOT_TARGET 기대치를 인식해 notTarget 카운트에 집계한다', () => {
    const actual: Record<string, TemplateActual> = {
      'known-not-target': {
        diagnostics: diagnostics({ uniqueNumbers: [] }),
        recommendations: 0,
      },
    };
    const expected: Record<string, TemplateExpectation> = {
      'known-not-target': {
        uniqueNumbers: 0,
        recommendations: 0,
        status: 'NOT_TARGET',
      },
    };

    const report = compareToExpectations(actual, expected, [
      'known-not-target',
    ]);

    expect(report.checked).toBe(1);
    expect(report.notTarget).toBe(1);
    expect(report.mismatches).toEqual([]);
  });

  it('기준 15b: NOT_TARGET 문서를 ok나 partial 카운트에 넣지 않는다', () => {
    const actual: Record<string, TemplateActual> = {
      'only-not-target': {
        diagnostics: diagnostics({ uniqueNumbers: [] }),
        recommendations: 0,
      },
    };
    const expected: Record<string, TemplateExpectation> = {
      'only-not-target': {
        uniqueNumbers: 0,
        recommendations: 0,
        status: 'NOT_TARGET',
      },
    };

    const report = compareToExpectations(actual, expected, [
      'only-not-target',
    ]);

    expect(report.notTarget).toBe(1);
    expect(report.ok).toBe(0);
    expect(report.partial).toBe(0);
  });

  it('기준 16a: NOT_TARGET 문서에서 권고문 청크가 하나라도 나오면 불일치로 보고한다', () => {
    const actual: Record<string, TemplateActual> = {
      'not-target-with-output': {
        diagnostics: diagnostics({ uniqueNumbers: ['R1'] }),
        recommendations: 1,
      },
    };
    const expected: Record<string, TemplateExpectation> = {
      'not-target-with-output': {
        uniqueNumbers: 0,
        recommendations: 0,
        status: 'NOT_TARGET',
      },
    };

    const report = compareToExpectations(actual, expected, [
      'not-target-with-output',
    ]);

    expect(report.notTarget).toBe(1);
    expectMismatch(report, 'not-target-with-output');
  });

  it('기준 16b: NOT_TARGET 문서의 실제 권고 산출도 0건이면 불일치가 없다', () => {
    const actual: Record<string, TemplateActual> = {
      'empty-not-target': {
        diagnostics: diagnostics({ uniqueNumbers: [] }),
        recommendations: 0,
      },
    };
    const expected: Record<string, TemplateExpectation> = {
      'empty-not-target': {
        uniqueNumbers: 0,
        recommendations: 0,
        status: 'NOT_TARGET',
      },
    };

    const report = compareToExpectations(actual, expected, [
      'empty-not-target',
    ]);

    expect(report.notTarget).toBe(1);
    expect(report.mismatches).toEqual([]);
  });

  it('기준 17a: 코드 목록에는 있지만 기대치가 NOT_TARGET이 아니면 불일치로 보고한다', () => {
    const actual: Record<string, TemplateActual> = {
      'listed-but-ok': {
        diagnostics: diagnostics({ uniqueNumbers: [] }),
        recommendations: 0,
      },
    };
    const expected: Record<string, TemplateExpectation> = {
      'listed-but-ok': {
        uniqueNumbers: 0,
        recommendations: 0,
        status: 'OK',
      },
    };

    const report = compareToExpectations(actual, expected, ['listed-but-ok']);

    expectMismatch(report, 'listed-but-ok');
  });

  it('기준 17b: 기대치는 NOT_TARGET인데 코드 목록에 없으면 불일치로 보고한다', () => {
    const actual: Record<string, TemplateActual> = {
      'expected-only-not-target': {
        diagnostics: diagnostics({ uniqueNumbers: [] }),
        recommendations: 0,
      },
    };
    const expected: Record<string, TemplateExpectation> = {
      'expected-only-not-target': {
        uniqueNumbers: 0,
        recommendations: 0,
        status: 'NOT_TARGET',
      },
    };

    const report = compareToExpectations(actual, expected, []);

    expect(report.notTarget).toBe(1);
    expectMismatch(report, 'expected-only-not-target');
  });

  it('기준 5d: notDerived 기대치와 실제 진단이 다르면 불일치로 보고한다', () => {
    const actual: Record<string, TemplateActual> = {
      'not-derived-drift': {
        diagnostics: diagnostics({
          uniqueNumbers: ['R1'],
          notDerived: ['R(Ⅲa-D-11)'],
        }),
        recommendations: 1,
      },
    };
    const expected: Record<string, TemplateExpectation> = {
      'not-derived-drift': {
        uniqueNumbers: 1,
        recommendations: 1,
        status: 'OK',
        notDerived: ['R(Ⅱa-C-7)'],
      },
    };

    const report = compareToExpectations(actual, expected);

    expectMismatch(report, 'not-derived-drift');
    // notDerived 비교가 우연히 선반영된 경우에도 현재 NOT_TARGET 스텁은 죽어야 한다.
    expectNotTargetComparisonActive();
  });

  it('기준 5e: notDerived가 있는 문서도 상태를 바꾸지 않고 OK일 수 있다', () => {
    const matchingActual: Record<string, TemplateActual> = {
      'ok-with-not-derived': {
        diagnostics: diagnostics({
          uniqueNumbers: ['R1'],
          notDerived: ['R(Ⅲa-D-11)'],
        }),
        recommendations: 1,
      },
    };
    const matchingExpected: Record<string, TemplateExpectation> = {
      'ok-with-not-derived': {
        uniqueNumbers: 1,
        recommendations: 1,
        status: 'OK',
        notDerived: ['R(Ⅲa-D-11)'],
      },
    };

    const matching = compareToExpectations(
      matchingActual,
      matchingExpected,
    );

    expect(matching.ok).toBe(1);
    expect(matching.partial).toBe(0);
    expect(matching.mismatches).toEqual([]);

    // notDerived를 무시하는 스텁이 위 OK 사례만으로 통과하지 않게 대조군을 둔다.
    const drift = compareToExpectations(matchingActual, {
      'ok-with-not-derived': {
        ...matchingExpected['ok-with-not-derived'],
        notDerived: [],
      },
    });
    expectMismatch(drift, 'ok-with-not-derived');
    expectNotTargetComparisonActive();
  });
});
