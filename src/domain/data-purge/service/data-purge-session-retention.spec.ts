// docs/specs/39 수용 기준 5, 15~23 동결 테스트 — 구현 중 수정 금지
import { dataPurgeConfig } from '../../../global/config/data-purge.config';
import { MetricsService } from '../../../global/observability/metrics/metrics.service';
import { RedisLock } from '../../../global/redis/redis-lock';
import { DataPurgeRepository } from '../repository/data-purge.repository';
import { DataPurgeService } from './data-purge.service';

interface TestConfig {
  enabled: boolean;
  cron: string;
  retentionDays: number;
  sessionRetentionDays: number;
  lockTtlMs: number;
  batchSize: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

const createTransactionManagerFake = (): object =>
  new Proxy<Record<string, unknown>>(
    {},
    {
      get: () =>
        async (...args: unknown[]): Promise<unknown> => {
          const callback = args.find(
            (value): value is (...callbackArgs: unknown[]) => unknown =>
              typeof value === 'function',
          );
          return callback ? callback() : undefined;
        },
    },
  );

const createHarness = ({
  retentionDays = 30,
  sessionRetentionDays = 30,
  batchSize = 200,
}: {
  retentionDays?: number;
  sessionRetentionDays?: number;
  batchSize?: number;
} = {}) => {
  const repository = {
    findPurgeableConversationIds: jest.fn(
      async (_cutoff: Date, _limit: number): Promise<string[]> => [],
    ),
    findPurgeablePatientIds: jest.fn(
      async (_cutoff: Date, _limit: number): Promise<string[]> => [],
    ),
    findPurgeableClinicIds: jest.fn(
      async (_cutoff: Date, _limit: number): Promise<string[]> => [],
    ),
    findPurgeableSessionIds: jest.fn(
      async (_sessionCutoff: Date, _limit: number): Promise<string[]> => [],
    ),
    countPurgeable: jest.fn(
      async (
        _cutoff: Date,
        _sessionCutoff?: Date,
      ): Promise<{
        conversations: number;
        patients: number;
        clinics: number;
        sessions: number;
      }> => ({ conversations: 0, patients: 0, clinics: 0, sessions: 0 }),
    ),
    purgeConversations: jest.fn(async (_ids: string[]): Promise<void> => undefined),
    purgePatients: jest.fn(async (_ids: string[]): Promise<void> => undefined),
    purgeClinics: jest.fn(async (_ids: string[]): Promise<void> => undefined),
    purgeSessions: jest.fn(async (_ids: string[]): Promise<void> => undefined),
  };
  const lock = {
    acquire: jest.fn(
      async (_key: string, _ttlMs: number): Promise<string | null> => 'test-lock-token',
    ),
    release: jest.fn(async (_key: string, _token: string): Promise<void> => undefined),
  };
  const metrics = {
    recordDataPurge: jest.fn(),
    observeDataPurgeDuration: jest.fn(),
  };
  const config: TestConfig = {
    enabled: true,
    cron: '0 18 * * *',
    retentionDays,
    sessionRetentionDays,
    lockTtlMs: 60_000,
    batchSize,
  };
  const subject = new DataPurgeService(
    repository as unknown as DataPurgeRepository,
    createTransactionManagerFake() as never,
    lock as unknown as RedisLock,
    config as never,
    metrics as unknown as MetricsService,
  );

  return { subject, repository, lock, metrics, config };
};

describe('DataPurgeService — docs/specs/39 refresh 세션 보존', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('기준 5: purge()의 sessions는 실제 세션 삭제 대상 수와 같다', async () => {
    const { subject, repository } = createHarness();
    const sessionIds = ['session-deleted-1', 'session-deleted-2'];
    repository.countPurgeable.mockResolvedValue({
      conversations: 0,
      patients: 0,
      clinics: 0,
      sessions: sessionIds.length,
    });
    repository.findPurgeableSessionIds.mockResolvedValue(sessionIds);

    const result = await subject.purge();

    expect(repository.purgeSessions).toHaveBeenCalledTimes(1);
    expect(repository.purgeSessions).toHaveBeenCalledWith(sessionIds);
    expect(result.sessions).toBe(sessionIds.length);
  });

  it('기준 15: sessionRetentionDays 변경량만큼 세션 컷오프가 달라진다', async () => {
    jest.useFakeTimers();
    const now = new Date('2026-08-05T04:05:06.789Z');
    jest.setSystemTime(now);

    const observedCutoffs: number[] = [];
    for (const sessionRetentionDays of [30, 7]) {
      const { subject, repository } = createHarness({ sessionRetentionDays });
      await subject.purge();

      expect(repository.findPurgeableSessionIds).toHaveBeenCalledTimes(1);
      const cutoff = repository.findPurgeableSessionIds.mock.calls[0][0];
      expect(cutoff).toBeInstanceOf(Date);
      expect(cutoff.getTime()).toBe(
        now.getTime() - sessionRetentionDays * MS_PER_DAY,
      );
      observedCutoffs.push(cutoff.getTime());
    }

    expect(observedCutoffs[1] - observedCutoffs[0]).toBe(23 * MS_PER_DAY);
  });

  it('기준 16: retentionDays만 바꿔도 세션 컷오프는 변하지 않는다', async () => {
    jest.useFakeTimers();
    const now = new Date('2026-08-05T04:05:06.789Z');
    jest.setSystemTime(now);

    const cutoffs: number[] = [];
    for (const retentionDays of [30, 3650]) {
      const { subject, repository } = createHarness({
        retentionDays,
        sessionRetentionDays: 30,
      });
      await subject.purge();

      expect(repository.findPurgeableSessionIds).toHaveBeenCalledTimes(1);
      cutoffs.push(repository.findPurgeableSessionIds.mock.calls[0][0].getTime());
    }

    expect(cutoffs).toEqual([
      now.getTime() - 30 * MS_PER_DAY,
      now.getTime() - 30 * MS_PER_DAY,
    ]);
  });

  it('기준 17: DATA_PURGE_SESSION_RETENTION_DAYS 미설정 시 기본값은 30이다', () => {
    const previous = process.env.DATA_PURGE_SESSION_RETENTION_DAYS;
    delete process.env.DATA_PURGE_SESSION_RETENTION_DAYS;

    try {
      expect(dataPurgeConfig().sessionRetentionDays).toBe(30);
    } finally {
      if (previous === undefined) {
        delete process.env.DATA_PURGE_SESSION_RETENTION_DAYS;
      } else {
        process.env.DATA_PURGE_SESSION_RETENTION_DAYS = previous;
      }
    }
  });

  it('기준 18: 배치 상한을 넘은 세션은 이번 틱의 삭제 목록에 들어가지 않는다', async () => {
    const { subject, repository } = createHarness({ batchSize: 2 });
    const candidates = ['session-1', 'session-2', 'session-next-tick'];
    repository.countPurgeable.mockResolvedValue({
      conversations: 0,
      patients: 0,
      clinics: 0,
      sessions: candidates.length,
    });
    repository.findPurgeableSessionIds.mockImplementation(
      async (_cutoff: Date, limit: number): Promise<string[]> =>
        candidates.slice(0, limit),
    );

    await subject.purge();

    expect(repository.findPurgeableSessionIds).toHaveBeenCalledWith(
      expect.any(Date),
      2,
    );
    expect(repository.purgeSessions).toHaveBeenCalledTimes(1);
    expect(repository.purgeSessions).toHaveBeenCalledWith(['session-1', 'session-2']);
    expect(repository.purgeSessions.mock.calls[0][0]).not.toContain('session-next-tick');
  });

  it('기준 19: 배치 상한으로 남긴 세션 수가 deferred에 포함된다', async () => {
    const { subject, repository } = createHarness({ batchSize: 2 });
    repository.countPurgeable.mockResolvedValue({
      conversations: 0,
      patients: 0,
      clinics: 0,
      sessions: 3,
    });
    repository.findPurgeableSessionIds.mockResolvedValue(['session-1', 'session-2']);

    const result = await subject.purge();

    expect(result.deferred).toBe(1);
  });

  it('기준 20: 락 미획득 틱은 세션 대상 산출을 하지 않는다', async () => {
    // 양성 대조: 락을 얻는 정상 틱에는 세션 축이 실제로 대상 산출에 합류해야 한다.
    const acquired = createHarness();
    await acquired.subject.purge();
    expect(acquired.repository.findPurgeableSessionIds).toHaveBeenCalledTimes(1);

    const skipped = createHarness();
    skipped.lock.acquire.mockResolvedValue(null);
    await skipped.subject.purge();

    expect(skipped.repository.findPurgeableSessionIds).not.toHaveBeenCalled();
    expect(skipped.repository.countPurgeable).not.toHaveBeenCalled();
    expect(skipped.repository.purgeSessions).not.toHaveBeenCalled();
  });

  it('기준 21: 락 미획득은 session skipped 메트릭을 기록한다', async () => {
    const { subject, lock, metrics } = createHarness();
    lock.acquire.mockResolvedValue(null);

    await subject.purge();

    expect(metrics.recordDataPurge).toHaveBeenCalledWith('session', 'skipped');
  });

  it('기준 22: 성공은 지운 세션 수만큼 session purged 메트릭을 기록한다', async () => {
    const { subject, repository, metrics } = createHarness();
    repository.countPurgeable.mockResolvedValue({
      conversations: 0,
      patients: 0,
      clinics: 0,
      sessions: 3,
    });
    repository.findPurgeableSessionIds.mockResolvedValue([
      'session-1',
      'session-2',
      'session-3',
    ]);

    await subject.purge();

    expect(metrics.recordDataPurge).toHaveBeenCalledWith('session', 'purged', 3);
  });

  it('기준 23: 세션 파기 예외는 session failed 메트릭을 기록한다', async () => {
    const { subject, repository, metrics } = createHarness();
    const failure = new Error('synthetic session purge failure');
    repository.countPurgeable.mockResolvedValue({
      conversations: 0,
      patients: 0,
      clinics: 0,
      sessions: 1,
    });
    repository.findPurgeableSessionIds.mockResolvedValue(['session-failure']);
    repository.purgeSessions.mockRejectedValue(failure);

    await expect(subject.purge()).rejects.toBe(failure);

    expect(metrics.recordDataPurge).toHaveBeenCalledWith('session', 'failed');
  });
});
