// docs/specs/24 수용 기준 11~12 동결 테스트 — 구현 중 수정 금지
import {
  findNotIngestTarget,
  NOT_INGEST_TARGETS,
  type NotIngestTarget,
} from './not-ingest-targets';

const target = (
  overrides: Partial<NotIngestTarget> = {},
): NotIngestTarget => ({
  sourceSystem: 'NCKM-SYNTHETIC',
  externalId: 'not-target-fixture',
  version: '2026-07',
  // docs/specs/25가 판정 축에 본문 해시를 더했다 — 합성 문서라 값 자체에 의미는 없다
  fileHash: 'not-target-fixture-hash',
  reason: '합성 문서가 권고 지침이 아닌 것으로 명시됨',
  ...overrides,
});

const identityOf = (
  value: NotIngestTarget,
): {
  sourceSystem: string;
  externalId: string;
  version: string;
  fileHash: string;
} => ({
  sourceSystem: value.sourceSystem,
  externalId: value.externalId,
  version: value.version,
  fileHash: value.fileHash,
});

describe('spec 24: 인제스트 대상 아님 목록', () => {
  it('기준 11a: 커밋된 모든 항목이 sourceSystem·externalId·version·reason을 갖는다', () => {
    // 빈 배열의 every/forEach가 공허하게 통과하지 않도록 목록의 존재부터 고정한다.
    expect(NOT_INGEST_TARGETS.length).toBeGreaterThan(0);

    for (const entry of NOT_INGEST_TARGETS) {
      expect(entry).toEqual(
        expect.objectContaining({
          sourceSystem: expect.stringMatching(/\S/),
          externalId: expect.stringMatching(/\S/),
          version: expect.stringMatching(/\S/),
          reason: expect.stringMatching(/\S/),
        }),
      );
    }
  });

  it('기준 11b: sourceSystem·externalId·version 세 축이 모두 같으면 항목을 반환한다', () => {
    const listed = NOT_INGEST_TARGETS[0];
    expect(listed).toBeDefined();
    if (!listed) {
      throw new Error('커밋된 대상 아님 목록이 비어 있습니다.');
    }

    expect(findNotIngestTarget(identityOf(listed))).toEqual(listed);
  });

  it('기준 11c: externalId가 다르면 항목을 찾지 못한다', () => {
    const listed = target();

    expect(
      findNotIngestTarget(
        { ...identityOf(listed), externalId: 'different-document' },
        [listed],
      ),
    ).toBeUndefined();
    // 항상 undefined인 스텁과 실제 식별자 비교를 구분하는 양성 대조군이다.
    expect(findNotIngestTarget(identityOf(listed), [listed])).toEqual(listed);
  });

  it('기준 11d: sourceSystem이 다르면 항목을 찾지 못한다', () => {
    const listed = target();

    expect(
      findNotIngestTarget(
        { ...identityOf(listed), sourceSystem: 'OTHER' },
        [listed],
      ),
    ).toBeUndefined();
    expect(findNotIngestTarget(identityOf(listed), [listed])).toEqual(listed);
  });

  it('기준 12a: version이 다르면 대상 아님 판정이 만료되어 찾지 못한다', () => {
    const listed = target();

    expect(
      findNotIngestTarget(
        { ...identityOf(listed), version: '2026-08' },
        [listed],
      ),
    ).toBeUndefined();
    expect(findNotIngestTarget(identityOf(listed), [listed])).toEqual(listed);
  });

  it('기준 12b: 커밋된 대상 아님 목록에 인제스트 대상 145와 219가 없다', () => {
    const externalIds = NOT_INGEST_TARGETS.map(({ externalId }) => externalId);

    expect(externalIds).not.toContain('145');
    expect(externalIds).not.toContain('219');
    // 빈 스텁이 위 두 부정 단언만으로 통과하지 못하게 한다.
    expect(NOT_INGEST_TARGETS).toHaveLength(15);
  });

  it('기준 12c: 커밋된 목록이 명세 B·C표의 대상 아님 15건을 모두 포함한다', () => {
    const externalIds = NOT_INGEST_TARGETS.map(({ externalId }) => externalId)
      .sort((left, right) => Number(left) - Number(right));

    expect(externalIds).toEqual([
      '90',
      '91',
      '92',
      '93',
      '94',
      '95',
      '96',
      '97',
      '98',
      '124',
      '125',
      '185',
      '239',
      '314',
      '668',
    ]);
  });
});
