import { Injectable } from '@nestjs/common';
import { type ScryptOptions, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, options, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });
}

// OWASP 권장 수준의 scrypt 파라미터. node:crypto 내장이라 네이티브 빌드 의존성이 없다.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/** 비밀번호 해시 형식: `scrypt.N.r.p.<salt b64url>.<hash b64url>` — 파라미터 상향 시에도 구 해시 검증 가능 */
@Injectable()
export class PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LEN);
    const derived = await scryptAsync(password, salt, KEY_LEN, {
      N,
      r: R,
      p: P,
      maxmem: 128 * N * R * 2,
    });
    return ['scrypt', N, R, P, salt.toString('base64url'), derived.toString('base64url')].join('.');
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('.');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
    const n = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const derived = await scryptAsync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r * 2,
    });
    return timingSafeEqual(derived, expected);
  }
}
