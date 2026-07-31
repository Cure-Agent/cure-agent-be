import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { guidelineScanConfig } from '../../global/config/guideline-scan.config';
import { GuidelineRevisionScanService } from '../../domain/guideline/service/guideline-revision-scan.service';

/** SchedulerRegistry에 등록되는 잡 이름 — 테스트가 이 이름으로 등록 여부를 확인한다 */
export const REVISION_SCAN_CRON_NAME = 'guideline-revision-scan';

/**
 * 개정 감지 크론 트리거 (docs/specs/26). architecture.md §3이 비워둔 `infrastructure/scheduler/` 자리다.
 *
 * **이 클래스는 `scan()`을 부르는 것 외에 아무 일도 하지 않는다.** 판정·잡 위임·통보는 전부
 * 도메인 서비스의 몫이고, 그 분리 덕에 e2e가 시간에 의존하지 않는다(기준 32).
 *
 * `@Cron` 데코레이터가 아니라 **`SchedulerRegistry`에 동적 등록**한다 — 기준 31이 「꺼져 있으면
 * 등록되지 않는다」를 요구하는데, 데코레이터는 정적이라 핸들러 안에서 early return 하는 것과
 * 구분되지 않기 때문이다.
 */
@Injectable()
export class GuidelineRevisionCron implements OnModuleInit {
  private readonly logger = new Logger(GuidelineRevisionCron.name);

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly scan: GuidelineRevisionScanService,
    @Inject(guidelineScanConfig.KEY)
    private readonly config: ConfigType<typeof guidelineScanConfig>,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.log(
        '개정 감지 크론을 등록하지 않는다 — GUIDELINE_REVISION_SCAN_ENABLED가 꺼져 있다',
      );
      return;
    }

    const job = new CronJob(this.config.cron, () => {
      // scan()은 예외를 밖으로 던지지 않는다 — 크론 핸들러를 죽이지 않기 위해서다
      void this.scan.scan();
    });

    this.registry.addCronJob(REVISION_SCAN_CRON_NAME, job);
    job.start();
    this.logger.log(`개정 감지 크론 등록: '${this.config.cron}' (프로세스 TZ 기준, 배포는 UTC)`);
  }
}
