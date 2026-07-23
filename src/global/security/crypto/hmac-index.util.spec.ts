import { HmacIndexUtil } from './hmac-index.util';

const encKeys = { v1: Buffer.alloc(32, 1) };

function build(hmacKey: Buffer): HmacIndexUtil {
  return new HmacIndexUtil({ encKeys, activeVersion: 'v1', hmacIndexKey: hmacKey });
}

describe('HmacIndexUtil', () => {
  const util = build(Buffer.alloc(32, 3));

  it('동일 평문 → 동일 인덱스 (equality 검색 보장)', () => {
    expect(util.index('CASE-001')).toBe(util.index('CASE-001'));
  });

  it('대소문자·공백·NFC 정규화 후 해시한다', () => {
    expect(util.index('  Case-001 ')).toBe(util.index('case-001'));
    expect(util.index('가'.normalize('NFD'))).toBe(util.index('가'.normalize('NFC')));
  });

  it('다른 평문 → 다른 인덱스', () => {
    expect(util.index('CASE-001')).not.toBe(util.index('CASE-002'));
  });

  it('다른 키 → 다른 인덱스 (키 없이 역산 불가)', () => {
    const other = build(Buffer.alloc(32, 4));
    expect(util.index('CASE-001')).not.toBe(other.index('CASE-001'));
  });
});
