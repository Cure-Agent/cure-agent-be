import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ServiceException } from '../../common/exception/service.exception';
import { cryptoConfig } from './crypto.config';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * 민감정보 필드 암호화 (architecture.md §4.5).
 * 암호문 형식: `<keyVersion>.<iv b64url>.<ciphertext b64url>.<tag b64url>`
 * 키 버전이 암호문에 포함되므로 키 로테이션 후에도 구 데이터를 복호화할 수 있다.
 */
@Injectable()
export class AesGcmUtil {
  constructor(
    @Inject(cryptoConfig.KEY)
    private readonly config: ConfigType<typeof cryptoConfig>,
  ) {}

  encrypt(plaintext: string): string {
    const version = this.config.activeVersion;
    const key = this.config.encKeys[version];
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [version, b64url(iv), b64url(ciphertext), b64url(tag)].join('.');
  }

  decrypt(payload: string): string {
    const parts = payload.split('.');
    if (parts.length !== 4) {
      throw new ServiceException('INTERNAL_ERROR', { reason: 'MALFORMED_CIPHERTEXT' });
    }
    const [version, ivB64, ciphertextB64, tagB64] = parts;
    const key = this.config.encKeys[version];
    if (!key) {
      throw new ServiceException('INTERNAL_ERROR', { reason: 'UNKNOWN_KEY_VERSION', version });
    }

    const tag = Buffer.from(tagB64, 'base64url');
    if (tag.length !== TAG_BYTES) {
      throw new ServiceException('INTERNAL_ERROR', { reason: 'MALFORMED_CIPHERTEXT' });
    }

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextB64, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // 인증 태그 불일치 = 변조 또는 잘못된 키
      throw new ServiceException('INTERNAL_ERROR', { reason: 'DECRYPTION_FAILED' });
    }
  }
}

function b64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}
