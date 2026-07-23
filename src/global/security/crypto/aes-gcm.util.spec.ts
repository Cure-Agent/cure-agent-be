import { ServiceException } from '../../common/exception/service.exception';
import { AesGcmUtil } from './aes-gcm.util';

const keyV1 = Buffer.alloc(32, 1);
const keyV2 = Buffer.alloc(32, 2);
const hmacIndexKey = Buffer.alloc(32, 3);

function build(activeVersion: string): AesGcmUtil {
  return new AesGcmUtil({ encKeys: { v1: keyV1, v2: keyV2 }, activeVersion, hmacIndexKey });
}

describe('AesGcmUtil', () => {
  it('암복호화 roundtrip', () => {
    const util = build('v1');
    const encrypted = util.encrypt('환자 진료 메모 🩺');
    expect(encrypted.startsWith('v1.')).toBe(true);
    expect(util.decrypt(encrypted)).toBe('환자 진료 메모 🩺');
  });

  it('같은 평문도 IV가 달라 암호문이 매번 다르다', () => {
    const util = build('v1');
    expect(util.encrypt('a')).not.toBe(util.encrypt('a'));
  });

  it('키 로테이션: active가 v2로 바뀌어도 v1 암호문을 복호화한다', () => {
    const oldCiphertext = build('v1').encrypt('legacy');
    const rotated = build('v2');
    expect(rotated.decrypt(oldCiphertext)).toBe('legacy');
    expect(rotated.encrypt('new').startsWith('v2.')).toBe(true);
  });

  it('변조된 암호문은 거부한다', () => {
    const util = build('v1');
    const [version, iv, ct, tag] = util.encrypt('tamper-me').split('.');
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 0xff;
    const tampered = [version, iv, flipped.toString('base64url'), tag].join('.');
    expect(() => util.decrypt(tampered)).toThrow(ServiceException);
  });

  it('알 수 없는 키 버전은 거부한다', () => {
    const util = build('v1');
    const payload = util.encrypt('x').replace(/^v1\./, 'v9.');
    expect(() => util.decrypt(payload)).toThrow(ServiceException);
  });

  it('형식이 깨진 암호문은 거부한다', () => {
    const util = build('v1');
    expect(() => util.decrypt('garbage')).toThrow(ServiceException);
  });
});
