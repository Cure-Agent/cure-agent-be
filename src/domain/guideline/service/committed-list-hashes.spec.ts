// docs/specs/25 수용 기준 13 동결 테스트 — 구현 중 수정 금지
import { KNOWN_SOURCE_DEFECTS } from './known-source-defects';
import { NOT_INGEST_TARGETS } from './not-ingest-targets';

const SHA256_HEX = /^[0-9a-f]{64}$/;

describe('spec 25: 커밋된 면제·제외 목록의 실측 fileHash', () => {
  it('기준 13a: NOT_INGEST_TARGETS의 모든 항목이 64자 소문자 hex fileHash를 갖는다', () => {
    expect(NOT_INGEST_TARGETS).toHaveLength(15);

    for (const entry of NOT_INGEST_TARGETS) {
      expect(entry.fileHash).toMatch(SHA256_HEX);
    }
  });

  it('기준 13b: KNOWN_SOURCE_DEFECTS의 모든 항목이 64자 소문자 hex fileHash를 갖는다', () => {
    expect(KNOWN_SOURCE_DEFECTS).toHaveLength(1);

    for (const entry of KNOWN_SOURCE_DEFECTS) {
      expect(entry.fileHash).toMatch(SHA256_HEX);
    }
  });

  it('기준 13c: 대상 아님 15건과 결함 면제 1건이 서로 다른 실측 해시 16건으로 커밋된다', () => {
    expect(NOT_INGEST_TARGETS).toHaveLength(15);
    expect(KNOWN_SOURCE_DEFECTS).toHaveLength(1);

    const committedHashes = [
      ...NOT_INGEST_TARGETS.map(({ fileHash }) => fileHash),
      ...KNOWN_SOURCE_DEFECTS.map(({ fileHash }) => fileHash),
    ];
    expect(committedHashes).toHaveLength(16);
    // 명세의 실측표는 16건이 전부 상이하다. 개수만 맞고 해시가 빈 스텁은 통과하지 못한다.
    expect(new Set(committedHashes).size).toBe(16);
  });
});
