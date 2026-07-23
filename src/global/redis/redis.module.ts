import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import Redis from 'ioredis';
import { redisConfig } from '../config/redis.config';

export const REDIS = Symbol('REDIS');

/**
 * Redis 클라이언트 (architecture.md §4.3 denylist, 이후 §11 캐시 공용).
 * - lazyConnect: 부팅 시 연결을 강제하지 않는다 — Redis는 가용성 필수 의존성이 아니다
 * - enableOfflineQueue=false: 장애 중엔 명령을 큐잉하지 않고 즉시 실패 → 소비자가 fail-open
 */
@Global()
@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [
    {
      provide: REDIS,
      inject: [redisConfig.KEY],
      useFactory: (config: ConfigType<typeof redisConfig>): Redis => {
        const client = new Redis(config.url, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          retryStrategy: (times) => Math.min(times * 500, 5_000),
        });
        // 오류는 명령 실행 지점에서 fail-open으로 처리한다 — 이벤트 스팸 방지용 no-op
        client.on('error', () => undefined);
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly client: Redis) {}

  onApplicationShutdown(): void {
    this.client.disconnect();
  }
}
