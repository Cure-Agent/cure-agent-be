/**
 * Readiness 확인 (docs/specs/16) — 의존성이 준비된 인스턴스에만 트래픽이 가도록 한다.
 * liveness(/health)와 분리한다: Redis는 fail-open이라 장애 중에도 앱은 살아 있어야 하지만(재시작 금지),
 * readiness는 "트래픽을 받아도 되는가"라 의존성이 끊기면 빠져야 한다.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { ServiceException } from '../global/common/exception/service.exception';
import { TransactionManager } from '../global/database/transaction-manager';
import { REDIS } from '../global/redis/redis.module';

export type DependencyStatus = 'up' | 'down';

export interface ReadinessResult {
  status: 'ready';
  dependencies: { database: DependencyStatus; redis: DependencyStatus };
}

@Injectable()
export class ReadinessService {
  constructor(
    private readonly txManager: TransactionManager,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async check(): Promise<ReadinessResult> {
    // 하나가 죽어도 나머지 상태를 함께 보고해야 원인 파악이 되므로 병렬로 확인한다
    const [database, redis] = await Promise.all([
      probe(() => this.txManager.conn.execute(sql`SELECT 1`)),
      probe(() => this.pingRedis()),
    ]);

    if (database === 'down' || redis === 'down') {
      throw new ServiceException('SERVICE_NOT_READY', { database, redis });
    }
    return { status: 'ready', dependencies: { database, redis } };
  }

  /**
   * Redis는 lazyConnect + enableOfflineQueue=false다(redis.module) — 연결을 연 적이 없으면
   * ping이 즉시 실패한다. readiness는 "지금 연결할 수 있는가"를 묻는 것이므로 여기서 연결을 연다.
   */
  private async pingRedis(): Promise<void> {
    if (this.redis.status === 'wait' || this.redis.status === 'end') {
      await this.redis.connect();
    }
    await this.redis.ping();
  }
}

async function probe(run: () => Promise<unknown>): Promise<DependencyStatus> {
  try {
    await run();
    return 'up';
  } catch {
    return 'down';
  }
}
