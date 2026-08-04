// docs/specs/34 수용 기준 19, 22 동결 테스트 — 구현 중 수정 금지
import { SchedulerRegistry } from '@nestjs/schedule';
import { DataPurgeService } from '../../domain/data-purge/service/data-purge.service';
import {
  DATA_PURGE_CRON_NAME,
  DataPurgeCron,
} from './data-purge.cron';

interface TestConfig {
  enabled: boolean;
  cron: string;
  retentionDays: number;
  lockTtlMs: number;
  batchSize: number;
}

const config = (enabled: boolean): TestConfig => ({
  enabled,
  cron: '0 0 1 1 *',
  retentionDays: 30,
  lockTtlMs: 60_000,
  batchSize: 200,
});

const stopRegisteredJobs = (registry: SchedulerRegistry): void => {
  for (const job of registry.getCronJobs().values()) job.stop();
};

describe('DataPurgeCron — docs/specs/34', () => {
  it('기준 19: disabled는 미등록이고 enabled는 data-purge 이름으로 등록된다', () => {
    const purgeService = {
      purge: jest.fn(async () => ({
        conversations: 0,
        patients: 0,
        deferred: 0,
        skipped: false,
      })),
    };
    const disabledRegistry = new SchedulerRegistry();
    const enabledRegistry = new SchedulerRegistry();

    try {
      new DataPurgeCron(
        disabledRegistry,
        purgeService as unknown as DataPurgeService,
        config(false) as never,
      ).onModuleInit();
      expect(disabledRegistry.getCronJobs().has(DATA_PURGE_CRON_NAME)).toBe(false);

      new DataPurgeCron(
        enabledRegistry,
        purgeService as unknown as DataPurgeService,
        config(true) as never,
      ).onModuleInit();
      expect(enabledRegistry.getCronJobs().has(DATA_PURGE_CRON_NAME)).toBe(true);
    } finally {
      stopRegisteredJobs(enabledRegistry);
      stopRegisteredJobs(disabledRegistry);
    }
  });

  it('기준 22: purge가 던져도 등록된 크론 핸들러 밖으로 예외가 전파되지 않는다', async () => {
    const registry = new SchedulerRegistry();
    const purge = jest.fn(async (): Promise<never> => {
      throw new Error('synthetic purge failure');
    });
    const subject = new DataPurgeCron(
      registry,
      { purge } as unknown as DataPurgeService,
      config(true) as never,
    );

    try {
      subject.onModuleInit();
      const job = registry.getCronJob(DATA_PURGE_CRON_NAME);

      await expect(Promise.resolve(job.fireOnTick())).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(purge).toHaveBeenCalledTimes(1);
    } finally {
      stopRegisteredJobs(registry);
    }
  });
});
