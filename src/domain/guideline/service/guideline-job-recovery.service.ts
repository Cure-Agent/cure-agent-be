import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { GuidelineJobRepository } from '../repository/guideline-job.repository';
import { PipelineRunRepository } from '../repository/pipeline-run.repository';

/**
 * 재시작으로 끊긴 잡·실행 정리 (docs/specs/22 수용 기준 11).
 *
 * 배포가 잡 도중에 컨테이너를 내리면 그 행은 영원히 `RUNNING`이고, partial unique index 때문에
 * **다음 잡도 시작할 수 없다.** 단일 인스턴스라 부팅 시점에 살아 있는 잡은 정의상 없으므로
 * 활성 행을 전부 `INTERRUPTED`로 내린다.
 *
 * 실행까지 정리하는 덕에 **죽는 순간 처리 중이던 문서가 phase와 함께 남는다**
 * (`324 / EMBED / INTERRUPTED`). phase는 건드리지 않는다 — 그게 「어디서 멈췄나」의 유일한 단서다.
 */
@Injectable()
export class GuidelineJobRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GuidelineJobRecoveryService.name);

  constructor(
    private readonly jobs: GuidelineJobRepository,
    private readonly runs: PipelineRunRepository,
    private readonly httpAdapterHost: HttpAdapterHost,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // CLI 스크립트도 이 훅을 탄다(`NestFactory.createApplicationContext`가 init을 부른다).
    // 서버가 도는 중에 `pnpm ingest` 같은 스크립트를 실행하면 **살아 있는 잡을 잘못 내린다** —
    // HTTP 어댑터가 없는 컨텍스트에서는 정리하지 않는다.
    if (!this.httpAdapterHost?.httpAdapter) return;

    try {
      const [jobs, runs] = await Promise.all([
        this.jobs.sweepInterrupted(),
        this.runs.sweepInterrupted(),
      ]);
      if (jobs > 0 || runs > 0) {
        this.logger.warn(`재시작으로 끊긴 잡 ${jobs}건·실행 ${runs}건을 INTERRUPTED로 정리했다`);
      }
    } catch (error) {
      // fail-open — DB 없이 app.init()만 부르는 스위트(contract·app e2e)를 깨뜨리지 않는다.
      // 정리에 실패해도 다음 부팅에서 다시 시도되고, 그때까지 막히는 것은 새 잡 생성뿐이다.
      this.logger.warn(`끊긴 잡 정리 실패 — 건너뛴다: ${String(error)}`);
    }
  }
}
