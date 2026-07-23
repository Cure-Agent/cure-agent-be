import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { cryptoConfig } from './crypto.config';

/**
 * 암호화 필드의 검색용 blind index (architecture.md §4.5).
 * 동일 평문 → 동일 인덱스가 보장되어 equality 검색에 사용한다.
 * 대소문자·공백·유니코드 정규화 차이로 인덱스가 갈라지지 않도록 정규화 후 해시한다.
 */
@Injectable()
export class HmacIndexUtil {
  constructor(
    @Inject(cryptoConfig.KEY)
    private readonly config: ConfigType<typeof cryptoConfig>,
  ) {}

  index(value: string): string {
    const normalized = value.normalize('NFC').trim().toLowerCase();
    return createHmac('sha256', this.config.hmacIndexKey).update(normalized).digest('base64url');
  }
}
