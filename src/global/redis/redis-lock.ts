import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from './redis.token';

/**
 * TTL 기반 분산 락 (docs/specs/26).
 *
 * **이 락은 fail-closed다 — `redis.module.ts`의 fail-open 규약에 대한 의도적 예외다.**
 * denylist(§4.3)가 fail-close면 Redis 장애가 로그인 전체를 막아 서비스가 죽지만, 스케줄러가
 * 락을 못 얻어 한 틱을 거르면 24시간 뒤에 다시 온다 — 잃는 것이 없다. 크론에서 fail-open은
 * 「락 없이 실행」이고, 그것은 락을 두지 않은 것과 같다.
 *
 * 해제는 **자기가 건 락만** 푼다(토큰 대조) — TTL이 지나 다른 실행이 잡은 락을 남의 finally가
 * 풀어버리면 락이 없는 것과 같아진다.
 */
@Injectable()
export class RedisLock {
  private readonly logger = new Logger(RedisLock.name);

  constructor(@Inject(REDIS) private readonly client: Redis) {}

  /**
   * `SET key token NX PX ttl` — 획득하면 해제용 토큰을, 실패하면 null을 돌려준다.
   * Redis 장애도 null이다(fail-closed): 호출자는 「락을 얻지 못했다」와 같이 다뤄야 한다.
   */
  async acquire(_key: string, _ttlMs: number): Promise<string | null> {
    // TODO(docs/specs/26): SET NX PX + 장애 시 null
    return null;
  }

  /** 토큰이 일치할 때만 해제한다 — 해제 실패는 삼킨다(TTL이 결국 푼다) */
  async release(_key: string, _token: string): Promise<void> {
    // TODO(docs/specs/26): 토큰 대조 후 DEL
  }
}
