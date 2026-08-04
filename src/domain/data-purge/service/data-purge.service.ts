import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { dataPurgeConfig } from '../../../global/config/data-purge.config';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { MetricsService } from '../../../global/observability/metrics/metrics.service';
import { RedisLock } from '../../../global/redis/redis-lock';
import { DataPurgeRepository } from '../repository/data-purge.repository';

/** 파기 락 키 — 개정 감지 스캔과 다른 키라 서로를 막지 않는다 */
export const DATA_PURGE_LOCK_KEY = 'lock:data-purge';

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface PurgeOutcome {
  /** 물리 삭제한 대화 수 */
  conversations: number;
  /** 물리 삭제한 환자 수 */
  patients: number;
  /** 물리 삭제한 refresh 세션 수 (docs/specs/39) */
  sessions: number;
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
    /**
     * 관측은 **선택 협력자**다 — 이 서비스는 관측 스택 없이도 성립해야 하고, 파기 로직을
     * 검증하는 유닛이 메트릭 레지스트리를 세울 이유가 없다. 운영에서는 @Global인
     * ObservabilityModule이 항상 주입한다.
     */
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * 유예 컷오프는 **여기서 계산한다** — SQL의 `now()`로 계산하면 기준 14의 시각 주입이
   * 성립하지 않는다(코드베이스에 Clock 추상화가 없고 fake timer는 `Date.now()`만 제어한다).
   */
  async purge(): Promise<PurgeOutcome> {
    const token = await this.lock.acquire(DATA_PURGE_LOCK_KEY, this.config.lockTtlMs);
    // fail-closed (§26 규약) — 경합이든 Redis 장애든 이 틱은 아무것도 하지 않는다.
    // 한 틱을 거르면 다음 주기에 다시 오고, 그 사이 잃는 것이 없다.
    if (token === null) {
      this.logger.log('파기 락을 얻지 못해 이번 틱을 건너뛴다');
      // skipped를 failed로 세면 「파기가 계속 실패 중」으로 읽혀 진짜 실패와 구분되지 않는다
      this.metrics?.recordDataPurge('conversation', 'skipped');
      this.metrics?.recordDataPurge('patient', 'skipped');
      this.metrics?.recordDataPurge('clinic', 'skipped');
      return { conversations: 0, patients: 0, sessions: 0, deferred: 0, skipped: true };
    }

    const startedAt = Date.now();
    try {
      const cutoff = new Date(Date.now() - this.config.retentionDays * MS_PER_DAY);
      const limit = this.config.batchSize;

      const [total, conversationIds, patientIds, clinicIds] = await Promise.all([
        this.repository.countPurgeable(cutoff),
        this.repository.findPurgeableConversationIds(cutoff, limit),
        this.repository.findPurgeablePatientIds(cutoff, limit),
        this.repository.findPurgeableClinicIds(cutoff, limit),
      ]);

      // 대화를 먼저 지운다 — 환자의 deletedAt은 그 환자 대화의 것보다 항상 같거나 늦으므로
      // 두 목록이 같은 틱에 잡히면 가이던스가 먼저 사라져 있어야 스냅샷·환자가 지워진다.
      // 클리닉 파기는 마지막이다 — 그 안에서 대화·환자를 clinic_id 기준으로 다시 훑으므로
      // 앞 두 단계가 남긴 것이 있어도 함께 정리된다 (docs/specs/36).
      await this.txManager.run(async () => {
        await this.repository.purgeConversations(conversationIds);
        await this.repository.purgePatients(patientIds);
        await this.repository.purgeClinics(clinicIds);
      });

      // 클리닉 미반영분도 센다 — 조용한 절단 금지(기준 21). `?? 0`은 클리닉 축이 없던
      // 시절의 호출자(부분 mock 포함)에서도 NaN이 되지 않게 하는 방어다.
      const deferred =
        total.conversations -
        conversationIds.length +
        (total.patients - patientIds.length) +
        ((total.clinics ?? 0) - clinicIds.length);
      if (deferred > 0) {
        // 조용한 절단 금지 — 남긴 수를 남겨야 「다 지웠다」로 오독되지 않는다
        this.logger.warn(`배치 상한(${limit})으로 ${deferred}건을 다음 틱으로 남긴다`);
      }

      this.metrics?.recordDataPurge('conversation', 'purged', conversationIds.length);
      this.metrics?.recordDataPurge('patient', 'purged', patientIds.length);
      this.metrics?.recordDataPurge('clinic', 'purged', clinicIds.length);

      return {
        conversations: conversationIds.length,
        patients: patientIds.length,
        sessions: 0, // 스텁 — docs/specs/39 구현에서 실제 삭제 수로 채운다
        deferred,
        skipped: false,
      };
    } catch (error) {
      this.metrics?.recordDataPurge('conversation', 'failed');
      this.metrics?.recordDataPurge('patient', 'failed');
      this.metrics?.recordDataPurge('clinic', 'failed');
      throw error;
    } finally {
      this.metrics?.observeDataPurgeDuration((Date.now() - startedAt) / 1_000);
      await this.lock.release(DATA_PURGE_LOCK_KEY, token);
    }
  }
}
