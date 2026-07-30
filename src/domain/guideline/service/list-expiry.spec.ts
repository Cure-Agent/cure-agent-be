// docs/specs/25 수용 기준 1~4 동결 테스트 — 구현 중 수정 금지
import { type ChunkDiagnostics } from '../../../infrastructure/document/guideline-chunker';
import {
  applyKnownSourceDefects,
  findExpiredSourceDefects,
  type KnownSourceDefect,
  type SourceDocumentIdentity,
} from './known-source-defects';
import {
  findExpiredNotIngestTarget,
  findNotIngestTarget,
  type NotIngestTarget,
} from './not-ingest-targets';

const RECORDED_VERSION = '2026-07';
const CURRENT_VERSION = '2026-08';
const RECORDED_HASH = '1'.repeat(64);
const CURRENT_HASH = '2'.repeat(64);

const identity = (
  overrides: Partial<SourceDocumentIdentity> = {},
): SourceDocumentIdentity => ({
  sourceSystem: 'NCKM-SYNTHETIC',
  externalId: 'expiry-fixture',
  version: RECORDED_VERSION,
  fileHash: RECORDED_HASH,
  ...overrides,
});

const target = (
  overrides: Partial<NotIngestTarget> = {},
): NotIngestTarget => ({
  ...identity(),
  reason: '합성 문서가 권고 지침이 아닌 것으로 명시됨',
  ...overrides,
});

const defect = (
  overrides: Partial<KnownSourceDefect> = {},
): KnownSourceDefect => ({
  ...identity(),
  diagnostic: 'duplicated',
  numbers: ['R20'],
  reason: '합성 문서에서 재현한 원문 번호 중복',
  ...overrides,
});

const diagnostics = (): ChunkDiagnostics => ({
  uniqueNumbers: ['R20', 'R21'],
  missing: ['R7'],
  duplicated: ['R20', 'R21'],
  gradeMissing: ['R30'],
  unknownEvidenceLevels: [],
  notDerived: [],
});

describe('spec 25: 면제·제외 목록 만료 후보 판별', () => {
  it('기준 1a: version이 다르면 findNotIngestTarget이 항목을 반환하지 않는다', () => {
    const listed = target();
    const current = identity({ version: CURRENT_VERSION });

    expect(findNotIngestTarget(current, [listed])).toBeUndefined();
    // 부정 단언만으로 항상 undefined인 스텁이 통과하지 못하게 만료 판별도 함께 고정한다.
    expect(findExpiredNotIngestTarget(current, [listed])).toEqual({
      entry: listed,
      mismatches: [
        {
          axis: 'version',
          recorded: RECORDED_VERSION,
          current: CURRENT_VERSION,
        },
      ],
    });
  });

  it('기준 1b: fileHash가 다르면 findNotIngestTarget이 항목을 반환하지 않는다', () => {
    const listed = target();
    const current = identity({ fileHash: CURRENT_HASH });

    expect(findNotIngestTarget(current, [listed])).toBeUndefined();
    expect(findExpiredNotIngestTarget(current, [listed])).toEqual({
      entry: listed,
      mismatches: [
        {
          axis: 'fileHash',
          recorded: RECORDED_HASH,
          current: CURRENT_HASH,
        },
      ],
    });
  });

  it('기준 1c: version이 다르면 applyKnownSourceDefects가 면제를 적용하지 않는다', () => {
    const listed = defect();
    const current = identity({ version: CURRENT_VERSION });
    const input = diagnostics();

    const result = applyKnownSourceDefects(input, current, [listed]);

    expect(result.diagnostics).toEqual(input);
    expect(result.applied).toEqual([]);
    expect(findExpiredSourceDefects(current, [listed])).toEqual([
      {
        entry: listed,
        mismatches: [
          {
            axis: 'version',
            recorded: RECORDED_VERSION,
            current: CURRENT_VERSION,
          },
        ],
      },
    ]);
  });

  it('기준 1d: fileHash가 다르면 applyKnownSourceDefects가 면제를 적용하지 않는다', () => {
    const listed = defect();
    const current = identity({ fileHash: CURRENT_HASH });
    const input = diagnostics();

    const result = applyKnownSourceDefects(input, current, [listed]);

    expect(result.diagnostics).toEqual(input);
    expect(result.applied).toEqual([]);
    expect(findExpiredSourceDefects(current, [listed])).toEqual([
      {
        entry: listed,
        mismatches: [
          {
            axis: 'fileHash',
            recorded: RECORDED_HASH,
            current: CURRENT_HASH,
          },
        ],
      },
    ]);
  });

  it('기준 2a: version이 어긋난 대상 아님 항목을 만료 후보로 반환한다', () => {
    const listed = target();
    const current = identity({ version: CURRENT_VERSION });

    const expired = findExpiredNotIngestTarget(current, [listed]);

    expect(expired).toBeDefined();
    expect(expired?.entry).toEqual(listed);
  });

  it('기준 2b: 대상 아님 만료 후보에 version의 기록값과 현재값을 담는다', () => {
    const listed = target();

    expect(
      findExpiredNotIngestTarget(
        identity({ version: CURRENT_VERSION }),
        [listed],
      ),
    ).toEqual({
      entry: listed,
      mismatches: [
        {
          axis: 'version',
          recorded: RECORDED_VERSION,
          current: CURRENT_VERSION,
        },
      ],
    });
  });

  it('기준 2c: findExpiredSourceDefects도 같은 형태로 만료된 면제 항목을 반환한다', () => {
    const listed = defect();

    expect(
      findExpiredSourceDefects(identity({ version: CURRENT_VERSION }), [
        listed,
      ]),
    ).toEqual([
      {
        entry: listed,
        mismatches: [
          {
            axis: 'version',
            recorded: RECORDED_VERSION,
            current: CURRENT_VERSION,
          },
        ],
      },
    ]);
  });

  it('기준 2d: sourceSystem 또는 externalId가 다르면 다른 문서이므로 만료 후보가 아니다', () => {
    const listedTarget = target();
    const listedDefect = defect();
    const sameDocument = identity({ version: CURRENT_VERSION });

    // 빈 결과 스텁과 실제 문서 식별자 필터를 구분하는 양성 대조군이다.
    expect(
      findExpiredNotIngestTarget(sameDocument, [listedTarget]),
    ).toBeDefined();
    expect(
      findExpiredSourceDefects(sameDocument, [listedDefect]),
    ).toHaveLength(1);

    for (const otherDocument of [
      identity({ sourceSystem: 'OTHER', version: CURRENT_VERSION }),
      identity({
        externalId: 'different-document',
        version: CURRENT_VERSION,
      }),
    ]) {
      expect(
        findExpiredNotIngestTarget(otherDocument, [listedTarget]),
      ).toBeUndefined();
      expect(
        findExpiredSourceDefects(otherDocument, [listedDefect]),
      ).toEqual([]);
    }
  });

  it('기준 3a: version은 같고 fileHash만 다르면 두 목록 모두 fileHash 만료 후보다', () => {
    const listedTarget = target();
    const listedDefect = defect();
    const current = identity({ fileHash: CURRENT_HASH });
    const expectedMismatch = {
      axis: 'fileHash' as const,
      recorded: RECORDED_HASH,
      current: CURRENT_HASH,
    };

    expect(findExpiredNotIngestTarget(current, [listedTarget])).toEqual({
      entry: listedTarget,
      mismatches: [expectedMismatch],
    });
    expect(findExpiredSourceDefects(current, [listedDefect])).toEqual([
      {
        entry: listedDefect,
        mismatches: [expectedMismatch],
      },
    ]);
  });

  it('기준 3b: 같은 version 재발행도 두 목록의 판정을 적용하지 않는다', () => {
    const listedTarget = target();
    const listedDefect = defect();
    const current = identity({ fileHash: CURRENT_HASH });
    const input = diagnostics();

    expect(findNotIngestTarget(current, [listedTarget])).toBeUndefined();
    const applied = applyKnownSourceDefects(input, current, [listedDefect]);
    expect(applied.diagnostics).toEqual(input);
    expect(applied.applied).toEqual([]);

    expect(
      findExpiredNotIngestTarget(current, [listedTarget]),
    ).toBeDefined();
    expect(
      findExpiredSourceDefects(current, [listedDefect]),
    ).toHaveLength(1);
  });

  it('기준 3c: version과 fileHash가 모두 다르면 두 mismatch를 모두 반환한다', () => {
    const listedTarget = target();
    const listedDefect = defect();
    const current = identity({
      version: CURRENT_VERSION,
      fileHash: CURRENT_HASH,
    });
    const expectedMismatches = [
      {
        axis: 'version' as const,
        recorded: RECORDED_VERSION,
        current: CURRENT_VERSION,
      },
      {
        axis: 'fileHash' as const,
        recorded: RECORDED_HASH,
        current: CURRENT_HASH,
      },
    ];

    const expiredTarget = findExpiredNotIngestTarget(current, [listedTarget]);
    expect(expiredTarget?.mismatches).toHaveLength(2);
    expect(expiredTarget?.mismatches).toEqual(
      expect.arrayContaining(expectedMismatches),
    );

    const expiredDefects = findExpiredSourceDefects(current, [listedDefect]);
    expect(expiredDefects).toHaveLength(1);
    expect(expiredDefects[0]?.mismatches).toHaveLength(2);
    expect(expiredDefects[0]?.mismatches).toEqual(
      expect.arrayContaining(expectedMismatches),
    );
  });

  it('기준 4a: 네 축이 모두 일치할 때만 findNotIngestTarget이 항목을 반환한다', () => {
    const listed = target();

    expect(findNotIngestTarget(identity(), [listed])).toEqual(listed);

    const changedFile = identity({ fileHash: CURRENT_HASH });
    expect(findNotIngestTarget(changedFile, [listed])).toBeUndefined();
    // 기존 3축 판정과 만료 함수 스텁을 모두 죽이는 네 번째 축 대조군이다.
    expect(findExpiredNotIngestTarget(changedFile, [listed])).toBeDefined();
  });

  it('기준 4b: 네 축 일치 시 두 목록의 만료 후보는 비어 있다', () => {
    const listedTarget = target();
    const listedDefect = defect();

    expect(
      findExpiredNotIngestTarget(identity(), [listedTarget]),
    ).toBeUndefined();
    expect(findExpiredSourceDefects(identity(), [listedDefect])).toEqual([]);

    // 항상 빈 값을 내는 스텁과 일치 결과를 구분하는 만료 양성 대조군이다.
    expect(
      findExpiredNotIngestTarget(
        identity({ fileHash: CURRENT_HASH }),
        [listedTarget],
      ),
    ).toBeDefined();
    expect(
      findExpiredSourceDefects(identity({ fileHash: CURRENT_HASH }), [
        listedDefect,
      ]),
    ).toHaveLength(1);
  });

  it('기준 4c: 네 축 일치 시 §23처럼 해당 번호만 진단에서 면제한다', () => {
    const listed = defect();
    const input = diagnostics();

    const exact = applyKnownSourceDefects(input, identity(), [listed]);

    expect(exact.applied).toEqual([listed]);
    expect(exact.diagnostics.duplicated).toEqual(['R21']);
    expect(exact.diagnostics.missing).toEqual(input.missing);
    expect(exact.diagnostics.gradeMissing).toEqual(input.gradeMissing);

    const changedFile = identity({ fileHash: CURRENT_HASH });
    const expired = applyKnownSourceDefects(input, changedFile, [listed]);
    expect(expired.diagnostics).toEqual(input);
    expect(expired.applied).toEqual([]);
    expect(findExpiredSourceDefects(changedFile, [listed])).toHaveLength(1);
  });
});
