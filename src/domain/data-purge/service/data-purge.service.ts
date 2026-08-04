import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { dataPurgeConfig } from '../../../global/config/data-purge.config';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { RedisLock } from '../../../global/redis/redis-lock';
import { DataPurgeRepository } from '../repository/data-purge.repository';

/** 파기 락 키 — 개정 감지 스캔과 다른 키라 서로를 막지 않는다 */
export const DATA_PURGE_LOCK_KEY = 'lock:data-purge';

export interface PurgeOutcome {
  /** 물리 삭제한 대화 수 */
  conversations: number;
  /** 물리 삭제한 환자 수 */
  patients: number;
  /** 배치 상한으로 이번 틱에서 남긴 뿌리 행 수 — 다음 틱이 가져간다 (기준 21) */
  deferred: number;
  /** 락을 얻지 못해 아무것도 하지 않았는가 (기준 20 — fail-closed) */
  skipped: boolean;
}

/**
 * 유예 경과분 물리 삭제 (docs/specs/34).
 *
 * **크론은 이 서비스를 부르는 것 외에 아무 일도 하지 않는다** — §26이 e2e를 시간 의존에서
 * 떼어낸 분리를 계승한다.
 */
@Injectable()
export class DataPurgeService {
  private readonly logger = new Logger(DataPurgeService.name);

  constructor(
    private readonly repository: DataPurgeRepository,
    private readonly txManager: TransactionManager,
    private readonly lock: RedisLock,
    @Inject(dataPurgeConfig.KEY)
    private readonly config: ConfigType<typeof dataPurgeConfig>,
  ) {}

  /**
   * 유예 컷오프는 **여기서 계산한다** — SQL의 `now()`로 계산하면 기준 14의 시각 주입이
   * 성립하지 않는다(코드베이스에 Clock 추상화가 없고 fake timer는 `Date.now()`만 제어한다).
   */
  async purge(): Promise<PurgeOutcome> {
    return Promise.resolve({ conversations: 0, patients: 0, deferred: 0, skipped: false });
  }
}
