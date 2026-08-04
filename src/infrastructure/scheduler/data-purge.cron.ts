import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { DataPurgeService } from '../../domain/data-purge/service/data-purge.service';
import { dataPurgeConfig } from '../../global/config/data-purge.config';

/** SchedulerRegistry에 등록되는 잡 이름 — 테스트가 이 이름으로 등록 여부를 확인한다 */
export const DATA_PURGE_CRON_NAME = 'data-purge';

/**
 * 유예 경과분 파기 크론 트리거 (docs/specs/34).
 *
 * **이 클래스는 `purge()`를 부르는 것 외에 아무 일도 하지 않는다** — 판정·삭제는 도메인
 * 서비스의 몫이고, 그 분리 덕에 e2e가 시간에 의존하지 않는다 (§26 선례).
 *
 * `@Cron` 데코레이터가 아니라 **`SchedulerRegistry`에 동적 등록**한다 — 기준 19가
 * 「꺼져 있으면 등록되지 않는다」를 요구하는데, 데코레이터는 정적이라 핸들러 안에서
 * early return 하는 것과 구분되지 않기 때문이다.
 */
@Injectable()
export class DataPurgeCron implements OnModuleInit {
  private readonly logger = new Logger(DataPurgeCron.name);

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly purgeService: DataPurgeService,
    @Inject(dataPurgeConfig.KEY)
    private readonly config: ConfigType<typeof dataPurgeConfig>,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.log('파기 크론을 등록하지 않는다 — DATA_PURGE_ENABLED가 꺼져 있다');
      return;
    }

    const job = new CronJob(this.config.cron, () => {
      // purge()는 예외를 밖으로 던지지 않는다 — 크론 핸들러를 죽이지 않기 위해서다
      void this.purgeService.purge().catch((error) => {
        this.logger.error(`파기 실패: ${String(error)}`);
      });
    });

    this.registry.addCronJob(DATA_PURGE_CRON_NAME, job);
    job.start();
    this.logger.log(
      `파기 크론 등록: '${this.config.cron}' (유예 ${this.config.retentionDays}일, 프로세스 TZ 기준·배포는 UTC)`,
    );
  }
}
