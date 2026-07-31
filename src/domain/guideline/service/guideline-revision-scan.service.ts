import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ulid } from 'ulid';
import { guidelineScanConfig } from '../../../global/config/guideline-scan.config';
import { RealTimeAlertSender } from '../../../global/observability/real-time-alert.sender';
import { RedisLock } from '../../../global/redis/redis-lock';
import { SourceListItem } from '../../../infrastructure/guideline-source/guideline-source.port';
import { GuidelineJobRow } from '../persistence/guideline-job.schema';
import {
  GuidelineJobRepository,
  isActiveGuidelineJobConflict,
} from '../repository/guideline-job.repository';
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
    // 락을 얻지 못하면(경합이든 Redis 장애든) 이 틱은 아무것도 하지 않는다 — fail-closed.
    // 목록 조회조차 하지 않으므로 상대 서버도 건드리지 않는다.
    const token = await this.lock.acquire(REVISION_SCAN_LOCK_KEY, this.config.lockTtlMs);
    if (!token) {
      this.logger.debug('개정 감지 스캔 건너뜀 — 락을 얻지 못했다');
      return;
    }

    try {
      const items = await this.listDocuments();
      if (!items) return;

      const candidates = await this.findCandidates(items);
      if (candidates.length === 0) {
        this.logger.debug(`개정 후보 없음 (목록 ${items.length}건)`);
        return;
      }

      await this.delegate(candidates);
    } catch (error) {
      // 크론 핸들러를 죽이지 않는다. 개별 실패의 진단은 잡 기록과 위 알림이 갖는다
      this.logger.error(`개정 감지 스캔 실패: ${String(error)}`);
    } finally {
      // **잡이 도는 동안 락은 이미 풀린다** — 락은 스캔 구간만 감싸고, 동시 실행 1개는
      // guideline_jobs의 partial unique index가 지킨다 (docs/specs/22)
      await this.lock.release(REVISION_SCAN_LOCK_KEY, token);
    }
  }

  /** 목록 조회 실패는 잡이 아예 안 도는 것이라 조용하면 안 된다 (기준 28) */
  private async listDocuments(): Promise<SourceListItem[] | null> {
    try {
      return await this.acquisition.listDocuments();
    } catch (error) {
      this.logger.error(`개정 감지용 원본 목록 조회 실패: ${String(error)}`);
      this.notify({
        title: '지침 개정 감지 실패 — 원본 목록 조회',
        detail: `원본 목록을 받지 못해 이번 스캔은 잡을 만들지 못했습니다: ${String(error)}`,
      });
      return null;
    }
  }

  /**
   * 후보 판정. **비교는 문자열 동등이다** — `sourceModifiedAt`은 로케일 의존 형식이라
   * 날짜로 파싱하면 판정이 서버 로케일에 걸린다(기준 4).
   */
  private async findCandidates(items: SourceListItem[]): Promise<string[]> {
    const sourceSystem = this.acquisition.sourceSystem;
    const candidates: string[] = [];

    for (const item of items) {
      const latest = await this.sourceDocuments.findLatestFetchedByExternalId(
        sourceSystem,
        item.externalId,
      );
      const current = item.sourceModifiedAt ?? null;

      // 본문을 받은 적이 없거나(신규 등록·실패 행만 있음), 목록이 값을 주지 않거나
      // (모르면 받아본다), 기록된 값과 다르면 후보다
      if (latest === null || current === null || latest.sourceModifiedAt !== current) {
        candidates.push(item.externalId);
      }
    }

    return candidates;
  }

  /**
   * 후보만 잡에 넘긴다. 활성 잡이 있으면 **이번 틱은 넘기지 않고 baseline도 오르지 않는다** —
   * 수집이 일어나지 않으므로 같은 후보가 다음 틱에 다시 잡힌다(기준 22).
   */
  private async delegate(candidates: string[]): Promise<void> {
    let row: GuidelineJobRow;
    try {
      row = await this.jobs.insert({
        id: ulid(),
        // 크론에는 대응하는 의료인이 없다 — 주체가 없는 것이 사실이므로 NULL이 사실이다
        requestedBy: null,
        triggeredBy: 'SCHEDULE',
      });
    } catch (error) {
      if (isActiveGuidelineJobConflict(error)) {
        this.logger.log(
          `활성 잡이 있어 이번 틱은 위임하지 않는다 — 후보 ${candidates.length}건은 다음 틱에 다시 잡힌다`,
        );
        return;
      }
      throw error;
    }

    this.logger.log(`개정 후보 ${candidates.length}건을 잡 ${row.id}에 위임한다`);
    // await하지 않는다 — 잡은 백그라운드로 끝까지 돌고, 락은 위 finally에서 곧 풀린다
    this.runner.start(row, candidates);
  }

  /** 알림 실패가 스캔 결과를 바꾸지 않는다 (§15 fire-and-forget) */
  private notify(event: { title: string; detail: string }): void {
    try {
      this.alerts.send(event);
    } catch (error) {
      this.logger.warn(`개정 감지 알림 발송 실패: ${String(error)}`);
    }
  }
}
