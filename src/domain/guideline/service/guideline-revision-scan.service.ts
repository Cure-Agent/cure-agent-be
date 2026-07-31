import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { guidelineScanConfig } from '../../../global/config/guideline-scan.config';
import { RealTimeAlertSender } from '../../../global/observability/real-time-alert.sender';
import { RedisLock } from '../../../global/redis/redis-lock';
import { GuidelineJobRepository } from '../repository/guideline-job.repository';
import { SourceDocumentRepository } from '../repository/source-document.repository';
import { GuidelineAcquisitionService } from './guideline-acquisition.service';
import { GuidelineJobRunner } from './guideline-job.runner';

/** 스캔 구간을 감싸는 락 키 — 잡이 아니라 「목록 조회 → 후보 산출 → 잡 생성」을 보호한다 */
export const REVISION_SCAN_LOCK_KEY = 'guideline:revision-scan:lock';

/**
 * 지침 개정 감지 스캔 (docs/specs/26).
 *
 * **크론 트리거와 분리돼 있다** — e2e가 `scan()`을 직접 불러 시간에 의존하지 않는다(기준 32).
 * `@Cron`이 붙은 클래스는 이 메서드를 호출하는 것 외에 아무 일도 하지 않는다.
 *
 * 판정은 두 층이다: 목록의 `sourceModifiedAt`으로 **후보를 좁히고**(POST 1회), 개정 확정은
 * §22 잡에 위임한다 — §18의 해시 partial unique와 §21의 `contentHash`가 이미 하는 일이라
 * 새 판정 코드가 없다.
 */
@Injectable()
export class GuidelineRevisionScanService {
  private readonly logger = new Logger(GuidelineRevisionScanService.name);

  constructor(
    private readonly acquisition: GuidelineAcquisitionService,
    private readonly sourceDocuments: SourceDocumentRepository,
    private readonly jobs: GuidelineJobRepository,
    private readonly runner: GuidelineJobRunner,
    private readonly lock: RedisLock,
    private readonly alerts: RealTimeAlertSender,
    @Inject(guidelineScanConfig.KEY)
    private readonly config: ConfigType<typeof guidelineScanConfig>,
  ) {}

  /**
   * 한 틱. 락을 얻은 실행만 스캔하고, 후보가 있으면 그 문서만 잡에 넘긴다.
   * 예외를 밖으로 던지지 않는다 — 크론 핸들러가 죽으면 다음 틱까지 조용해진다.
   */
  async scan(): Promise<void> {
    // TODO(docs/specs/26): 락 획득(fail-closed) → 목록 조회 → 후보 산출 → 잡 위임
  }
}
