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
  /**
   * 이번 틱이 시작할 때 있던 후보 중 못 지운 뿌리 행 수 — 다음 틱이 가져간다 (기준 21).
   * 배치 상한·락 연장 실패로 남긴 것과, 대화 행이 남아 보류된 환자(이슈 #473)를 모두 포함한다.
   */
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
      // 세션 축도 함께 올린다 — 이 축만 결말이 비면 대시보드에서 「돌지 않는 축」으로 읽힌다
      this.metrics?.recordDataPurge('session', 'skipped');
      return { conversations: 0, patients: 0, sessions: 0, deferred: 0, skipped: true };
    }

    const startedAt = Date.now();
    try {
      const cutoff = new Date(Date.now() - this.config.retentionDays * MS_PER_DAY);
      // 세션 컷오프는 **따로** 계산한다 (docs/specs/39) — 임상 데이터 유예와 축이 분리돼야 한다.
      const sessionCutoff = new Date(
        Date.now() - this.config.sessionRetentionDays * MS_PER_DAY,
      );
      const limit = this.config.batchSize;
      const maxBatches = this.config.maxBatchesPerTick;

      // 총수는 틱 시작 시 1회만 센다 — deferred는 「이 틱이 시작할 때 있던 것 중 못 지운 수」다.
      const total = await this.repository.countPurgeable(cutoff, sessionCutoff);
      const purged = { conversations: 0, patients: 0, clinics: 0, sessions: 0 };

      /**
       * 배치를 **틱 안에서 반복**한다 (이슈 #473). 어느 축이든 뽑힌 수가 상한과 같으면 뒤에 더 있을
       * 수 있으므로 이어 돈다. 배치마다 별도 트랜잭션이다 — 한 배치의 실패가 앞 배치를 되돌리지
       * 않고, 한 트랜잭션의 크기는 여전히 상한으로 묶인다. 락은 배치 사이에 연장하며, 연장이
       * 실패하면 fail-closed로 멈춘다(§26 규약 — 락 없이 도는 것은 락을 두지 않은 것과 같다).
       */
      let batches = 0;
      let stopReason: string | null = null;
      // 첫 배치는 반드시 돌고 상한 검사는 뒤에 온다 — maxBatchesPerTick이 없던 호출자(옛 유닛
      // 하네스)도 단일 배치 동작을 그대로 얻는다.
      for (;;) {
        if (batches > 0) {
          const extended = await this.lock.extend(
            DATA_PURGE_LOCK_KEY,
            token,
            this.config.lockTtlMs,
          );
          if (!extended) {
            stopReason = '락 연장 실패';
            break;
          }
        }

        const [conversationIds, patientIds, clinicIds, sessionIds] = await Promise.all([
          this.repository.findPurgeableConversationIds(cutoff, limit),
          this.repository.findPurgeablePatientIds(cutoff, limit),
          this.repository.findPurgeableClinicIds(cutoff, limit),
          this.repository.findPurgeableSessionIds(sessionCutoff, limit),
        ]);

        // 대화를 먼저 지운다 — 환자 후보는 자기 대화 행이 남아 있으면 이미 제외돼 있으므로
        // (리포지토리), 여기 순서는 같은 배치 안의 FK 역순을 지키는 것이다.
        // 클리닉 파기는 마지막이다 — 그 안에서 대화·환자를 clinic_id 기준으로 다시 훑으므로
        // 앞 두 단계가 남긴 것이 있어도 함께 정리된다 (docs/specs/36).
        await this.txManager.run(async () => {
          await this.repository.purgeConversations(conversationIds);
          await this.repository.purgePatients(patientIds);
          await this.repository.purgeClinics(clinicIds);
          // 세션은 참조 FK가 0개인 잎이라 **순서와 무관하다**. 클리닉 파기(§36 ④)가 같은 행을
          // 이미 지웠어도 id 기준 DELETE라 충돌하지 않는다 — 두 경로는 공존한다.
          await this.repository.purgeSessions(sessionIds);
        });

        purged.conversations += conversationIds.length;
        purged.patients += patientIds.length;
        purged.clinics += clinicIds.length;
        purged.sessions += sessionIds.length;
        batches += 1;

        const anyFull =
          conversationIds.length >= limit ||
          patientIds.length >= limit ||
          clinicIds.length >= limit ||
          sessionIds.length >= limit;
        if (!anyFull) break;
        if (!(batches < maxBatches)) {
          stopReason = `틱당 배치 상한(${maxBatches})`;
          break;
        }
      }

      // 못 지운 수 — 배치 상한으로 남긴 것과 대화가 남아 건너뛴 환자를 모두 포함한다(기준 21,
      // 조용한 절단 금지). 클리닉 파기가 총수에 잡힌 대화·환자를 함께 지우면 음수가 될 수 있어
      // 0에서 자른다. `?? 0`은 클리닉·세션 축이 없던 시절의 호출자(부분 mock 포함) 방어다.
      const deferred = Math.max(
        0,
        total.conversations -
          purged.conversations +
          (total.patients - purged.patients) +
          ((total.clinics ?? 0) - purged.clinics) +
          ((total.sessions ?? 0) - purged.sessions),
      );
      if (deferred > 0) {
        this.logger.warn(
          `${stopReason ?? '대화가 남은 환자 보류'}로 ${deferred}건을 다음 틱으로 남긴다 (배치 ${batches}회)`,
        );
      }

      this.metrics?.recordDataPurge('conversation', 'purged', purged.conversations);
      this.metrics?.recordDataPurge('patient', 'purged', purged.patients);
      this.metrics?.recordDataPurge('clinic', 'purged', purged.clinics);
      this.metrics?.recordDataPurge('session', 'purged', purged.sessions);

      return {
        conversations: purged.conversations,
        patients: purged.patients,
        sessions: purged.sessions,
        deferred,
        skipped: false,
      };
    } catch (error) {
      this.metrics?.recordDataPurge('conversation', 'failed');
      this.metrics?.recordDataPurge('patient', 'failed');
      this.metrics?.recordDataPurge('clinic', 'failed');
      this.metrics?.recordDataPurge('session', 'failed');
      throw error;
    } finally {
      this.metrics?.observeDataPurgeDuration((Date.now() - startedAt) / 1_000);
      await this.lock.release(DATA_PURGE_LOCK_KEY, token);
    }
  }
}
