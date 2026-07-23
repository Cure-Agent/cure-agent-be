import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { RealTimeAlertSender } from '../observability/real-time-alert.sender';
import { REDIS } from '../redis/redis.module';

const ALERT_DEDUPE_MS = 5 * 60 * 1000;

/**
 * access 토큰 즉시 무효화 denylist (architecture.md §4.3).
 * - 로그아웃·재사용 감지 시 familyId를 access TTL 동안 기록한다
 * - Redis 장애 시 fail-open: 기본 보안선은 access TTL(≤15분)이며, denylist는 방어 계층이다
 */
@Injectable()
export class TokenDenylistService {
  private readonly logger = new Logger(TokenDenylistService.name);
  private lastAlertAt = 0;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly alertSender: RealTimeAlertSender,
  ) {}

  async denyFamily(familyId: string, ttlSec: number): Promise<void> {
    try {
      // 클록 스큐 여유분을 더해 access 토큰 잔여 수명을 확실히 덮는다
      await this.redis.set(this.key(familyId), '1', 'EX', ttlSec + 60);
    } catch (error) {
      this.failOpen('denyFamily', error);
    }
  }

  async isDenied(familyId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(this.key(familyId))) === 1;
    } catch (error) {
      this.failOpen('isDenied', error);
      return false;
    }
  }

  private key(familyId: string): string {
    return `auth:deny:fid:${familyId}`;
  }

  private failOpen(operation: string, error: unknown): void {
    this.logger.warn(`Redis ${operation} 실패 — fail-open: ${String(error)}`);
    const now = Date.now();
    if (now - this.lastAlertAt > ALERT_DEDUPE_MS) {
      this.lastAlertAt = now;
      this.alertSender.send({
        title: 'REDIS_UNAVAILABLE',
        detail: `토큰 denylist ${operation} 실패 — fail-open 동작 중 (즉시 무효화 보장 상실, 최대 access TTL 창)`,
      });
    }
  }
}
