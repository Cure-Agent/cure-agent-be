import { Injectable } from '@nestjs/common';

const DEFAULT_BLOCK_SEC = 60;

/**
 * 429 감지 시 프로바이더를 Retry-After 기준으로 차단한다 (architecture.md §11-3).
 * 단일 인스턴스 in-memory — 멀티 인스턴스 공유는 Redis 이관으로 확장(P1).
 */
@Injectable()
export class RateLimitBlockStore {
  private readonly blockedUntil = new Map<string, number>();

  block(provider: string, retryAfterSec?: number): void {
    const sec = retryAfterSec && retryAfterSec > 0 ? retryAfterSec : DEFAULT_BLOCK_SEC;
    this.blockedUntil.set(provider, Date.now() + sec * 1000);
  }

  isBlocked(provider: string): boolean {
    const until = this.blockedUntil.get(provider);
    if (!until) return false;
    if (Date.now() >= until) {
      this.blockedUntil.delete(provider);
      return false;
    }
    return true;
  }
}
