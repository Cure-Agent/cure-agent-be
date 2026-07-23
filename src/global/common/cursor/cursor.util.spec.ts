import { ServiceException } from '../exception/service.exception';
import { decodeCursor, encodeCursor } from './cursor.util';

describe('cursor.util', () => {
  it('encode → decode roundtrip', () => {
    const payload = { k: '2026-07-24T00:00:00.000Z', id: 'abc' };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it('불투명성: 인코딩 결과에 원문 키가 노출되지 않는다', () => {
    expect(encodeCursor({ id: 'abc' })).not.toContain('abc');
  });

  it('깨진 커서는 BAD_REQUEST로 거부한다', () => {
    expect(() => decodeCursor('%%%not-base64%%%')).toThrow(ServiceException);
    try {
      decodeCursor('%%%not-base64%%%');
    } catch (e) {
      expect((e as ServiceException).code).toBe('BAD_REQUEST');
    }
  });

  it('객체가 아닌 JSON은 거부한다', () => {
    const notObject = Buffer.from('42', 'utf8').toString('base64url');
    expect(() => decodeCursor(notObject)).toThrow(ServiceException);
  });
});
