/**
 * Readiness 확인 (docs/specs/16) — 의존성이 준비된 인스턴스에만 트래픽이 가도록 한다.
 * liveness(/health)와 분리한다: Redis는 fail-open이라 장애 중에도 앱은 살아 있어야 하지만(재시작 금지),
 * readiness는 "트래픽을 받아도 되는가"라 의존성이 끊기면 빠져야 한다.
 */
import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
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

  check(): Promise<ReadinessResult> {
    throw new Error('ReadinessService.check 미구현 (docs/specs/16)');
  }
}
