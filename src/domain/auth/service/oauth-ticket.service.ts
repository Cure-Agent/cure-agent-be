import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { REDIS } from '../../../global/redis/redis.module';
import { OAuthProviderId } from '../../../infrastructure/oauth/oauth-provider.port';

/** 콜백에서 온보딩 완료까지 소셜 신원을 실어 나르는 1회용 티켓의 내용물 */
export interface OAuthTicketPayload {
  provider: OAuthProviderId;
  providerId: string;
  email: string;
  /** 제공자가 준 이름 — 온보딩 폼 기본값으로만 쓴다 */
  displayName: string | null;
}

/** lazyConnect 클라이언트의 최초 연결 대기 상한 */
const CONNECT_WAIT_MS = 3_000;

/**
 * 신규 가입 티켓 (docs/specs/17).
 * 검증된 소셜 신원(provider/providerId/email)을 브라우저에 노출하지 않고 서버에 보관한다 —
 * FE가 넘기는 건 불투명 티켓뿐이라 이메일·providerId를 위조할 수 없다.
 *
 * denylist(§4.3)와 달리 **fail-closed**다: Redis 장애 시 가입을 진행시키면
 * 검증되지 않은 신원으로 계정이 생길 수 있다.
 */
@Injectable()
export class OAuthTicketService {
  private readonly logger = new Logger(OAuthTicketService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async issue(payload: OAuthTicketPayload, ttlSec: number): Promise<string> {
    const ticket = randomBytes(32).toString('base64url');
    try {
      await this.ensureReady();
      await this.redis.set(this.key(ticket), JSON.stringify(payload), 'EX', ttlSec);
    } catch (error) {
      this.logger.error(`OAuth 티켓 발급 실패 (Redis): ${String(error)}`);
      throw new ServiceException('AUTH_OAUTH_FAILED');
    }
    return ticket;
  }

  /** 1회성 — 조회와 삭제를 GETDEL로 원자 처리해 티켓 재사용을 막는다. */
  async consume(ticket: string): Promise<OAuthTicketPayload> {
    let raw: string | null;
    try {
      await this.ensureReady();
      raw = await this.redis.getdel(this.key(ticket));
    } catch (error) {
      this.logger.error(`OAuth 티켓 조회 실패 (Redis): ${String(error)}`);
      throw new ServiceException('AUTH_OAUTH_TICKET_INVALID');
    }
    if (!raw) throw new ServiceException('AUTH_OAUTH_TICKET_INVALID');

    try {
      return JSON.parse(raw) as OAuthTicketPayload;
    } catch {
      throw new ServiceException('AUTH_OAUTH_TICKET_INVALID');
    }
  }

  private key(ticket: string): string {
    return `auth:oauth:ticket:${ticket}`;
  }

  /**
   * RedisModule은 lazyConnect + 오프라인 큐 비활성이라, 부팅 후 첫 명령은 연결이 없어 즉시 실패한다.
   * denylist는 fail-open이라 이를 감수하지만 티켓은 fail-closed이므로 연결을 열고 ready를 기다린다.
   */
  private ensureReady(): Promise<void> {
    if (this.redis.status === 'ready') return Promise.resolve();
    if (this.redis.status === 'wait') void this.redis.connect().catch(() => undefined);

    return new Promise((resolve, reject) => {
      const onReady = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.redis.off('ready', onReady);
        reject(new Error(`Redis 연결 대기 ${CONNECT_WAIT_MS}ms 초과`));
      }, CONNECT_WAIT_MS);
      timer.unref();
      this.redis.once('ready', onReady);
    });
  }
}
