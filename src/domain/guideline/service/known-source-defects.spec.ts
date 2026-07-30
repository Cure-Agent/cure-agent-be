// docs/specs/23 수용 기준 9~13 동결 테스트 — 구현 중 수정 금지
import {
  makeKnownDefectDiagnosticsSample,
  knownDefectIdentitySample,
} from '../../../../test/fixtures/nckm-residual-samples';
import { type ChunkDiagnostics } from '../../../infrastructure/document/guideline-chunker';
import {
  applyKnownSourceDefects,
  type KnownSourceDefect,
  type SourceDocumentIdentity,
} from './known-source-defects';

const identity = (): SourceDocumentIdentity => ({ ...knownDefectIdentitySample });

const defect = (
  overrides: Partial<KnownSourceDefect> = {},
): KnownSourceDefect => ({
  sourceSystem: knownDefectIdentitySample.sourceSystem,
  externalId: knownDefectIdentitySample.externalId,
  version: knownDefectIdentitySample.version,
  diagnostic: 'duplicated',
  numbers: ['R20'],
  reason: '합성 문서에서 재현한 원문 번호 중복',
  ...overrides,
});

describe('spec 23: 알려진 원문 결함 면제', () => {
  it('기준 9: 명시 항목의 모든 식별 조건과 번호에만 면제를 적용한다', () => {
    const diagnostics: ChunkDiagnostics = makeKnownDefectDiagnosticsSample();
    const explicitDefect: KnownSourceDefect = {
      sourceSystem: knownDefectIdentitySample.sourceSystem,
      externalId: knownDefectIdentitySample.externalId,
      version: knownDefectIdentitySample.version,
      diagnostic: 'missing',
      numbers: ['R7'],
      reason: '합성 원문에서 R7 권고 블록이 누락됨',
    };

    const result = applyKnownSourceDefects(diagnostics, identity(), [
      explicitDefect,
    ]);

    expect(result.diagnostics.missing).toEqual(['R8']);
    expect(result.diagnostics.duplicated).toEqual(['R20', 'R21']);
    expect(result.diagnostics.gradeMissing).toEqual(['R30']);
  });

  it('기준 10: 같은 문서와 진단에서도 명시된 번호만 면제한다', () => {
    const diagnostics: ChunkDiagnostics = makeKnownDefectDiagnosticsSample();
    const r20Defect = defect({ numbers: ['R20'] });

    const result = applyKnownSourceDefects(diagnostics, identity(), [r20Defect]);

    expect(result.diagnostics.duplicated).toEqual(['R21']);
    expect(result.diagnostics.missing).toEqual(['R7', 'R8']);
    expect(result.diagnostics.gradeMissing).toEqual(['R30']);
  });

  it('기준 11: 버전과 sourceSystem과 externalId 중 하나라도 다르면 면제를 적용하지 않는다', () => {
    const r20Defect = defect();
    const mismatchedIdentities: SourceDocumentIdentity[] = [
      { ...identity(), version: '2026-08' },
      { ...identity(), sourceSystem: 'OTHER' },
      { ...identity(), externalId: 'different-document' },
    ];

    for (const mismatchedIdentity of mismatchedIdentities) {
      const diagnostics: ChunkDiagnostics = makeKnownDefectDiagnosticsSample();
      const result = applyKnownSourceDefects(
        diagnostics,
        mismatchedIdentity,
        [r20Defect],
      );

      expect(result.diagnostics).toEqual(diagnostics);
      expect(result.applied).toEqual([]);
    }
  });

  it('기준 12: 실제 적용된 면제 항목을 applied로 돌려준다', () => {
    const diagnostics: ChunkDiagnostics = makeKnownDefectDiagnosticsSample();
    const duplicatedDefect = defect({
      diagnostic: 'duplicated',
      numbers: ['R20'],
    });
    const missingDefect = defect({
      diagnostic: 'missing',
      numbers: ['R7'],
      reason: '합성 원문에서 R7 권고 블록이 누락됨',
    });
    const otherDocumentDefect = defect({
      externalId: 'different-document',
      diagnostic: 'gradeMissing',
      numbers: ['R30'],
    });

    const result = applyKnownSourceDefects(diagnostics, identity(), [
      duplicatedDefect,
      missingDefect,
      otherDocumentDefect,
    ]);

    expect(result.applied).toEqual([duplicatedDefect, missingDefect]);
  });

  it('기준 13: 면제된 진단의 사본을 반환하고 입력 객체를 변형하지 않는다', () => {
    const diagnostics: ChunkDiagnostics = makeKnownDefectDiagnosticsSample();
    const before: ChunkDiagnostics = {
      uniqueNumbers: [...diagnostics.uniqueNumbers],
      missing: [...diagnostics.missing],
      duplicated: [...diagnostics.duplicated],
      gradeMissing: [...diagnostics.gradeMissing],
      unknownEvidenceLevels: diagnostics.unknownEvidenceLevels.map((entry) => ({
        ...entry,
      })),
    };

    const result = applyKnownSourceDefects(diagnostics, identity(), [defect()]);

    expect(result.diagnostics).not.toBe(diagnostics);
    expect(result.diagnostics.duplicated).toEqual(['R21']);
    expect(result.diagnostics.unknownEvidenceLevels).toEqual(
      before.unknownEvidenceLevels,
    );
    expect(diagnostics).toEqual(before);
  });
});
