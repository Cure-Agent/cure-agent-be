import { registerAs } from '@nestjs/config';

export interface CryptoKeys {
  /** 버전 → 32바이트 AES-256 키. 로테이션 시 새 버전을 추가하고 activeVersion만 올린다. */
  encKeys: Record<string, Buffer>;
  activeVersion: string;
  hmacIndexKey: Buffer;
}

export const cryptoConfig = registerAs('crypto', (): CryptoKeys => {
  const raw = JSON.parse(process.env.CRYPTO_ENC_KEYS ?? '{}') as Record<string, string>;
  const encKeys = Object.fromEntries(
    Object.entries(raw).map(([version, b64]) => [version, Buffer.from(b64, 'base64')]),
  );
  return {
    encKeys,
    activeVersion: process.env.CRYPTO_ENC_ACTIVE_VERSION ?? '',
    hmacIndexKey: Buffer.from(process.env.CRYPTO_HMAC_INDEX_KEY ?? '', 'base64'),
  };
});
