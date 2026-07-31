import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { ulid } from 'ulid';
import { REDIS } from './redis.token';

/** 내가 건 락일 때만 지운다 — 대조와 삭제가 한 원자 단위여야 한다 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

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
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = ulid();
    try {
      const result = await this.client.set(key, token, 'PX', ttlMs, 'NX');
      return result === 'OK' ? token : null;
    } catch (error) {
      // fail-closed — 못 얻은 것으로 다룬다. 스캔을 한 틱 거르면 다음 주기에 다시 온다
      this.logger.warn(`락 획득 실패(${key}): ${String(error)}`);
      return null;
    }
  }

  /**
   * 토큰이 일치할 때만 해제한다 — 해제 실패는 삼킨다(TTL이 결국 푼다).
   *
   * GET·DEL을 나눠 하면 그 사이에 TTL이 지나 **다른 실행이 잡은 락을 지울 수 있다.**
   * Lua로 한 원자 단위에 묶는다.
   */
  async release(key: string, token: string): Promise<void> {
    try {
      await this.client.eval(RELEASE_SCRIPT, 1, key, token);
    } catch (error) {
      this.logger.warn(`락 해제 실패(${key}): ${String(error)}`);
    }
  }
}
