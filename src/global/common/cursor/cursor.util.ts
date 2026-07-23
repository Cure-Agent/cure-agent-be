import { ServiceException } from '../exception/service.exception';

/**
 * 불투명 커서 (architecture.md §10.4).
 * 내부 정렬키를 계약에 노출하지 않도록 base64url(JSON)로 인코딩한다.
 */
export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor<T extends Record<string, unknown>>(cursor: string): T {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('not an object');
    }
    return decoded as T;
  } catch {
    throw new ServiceException('BAD_REQUEST', { reason: 'INVALID_CURSOR' });
  }
}
