// 이슈 #473 수용 기준 동결 테스트 — 구현 중 수정 금지
import { Logger } from '@nestjs/common';
import { DataPurgeRepository } from '../repository/data-purge.repository';
import { MetricsService } from '../../../global/observability/metrics/metrics.service';
import { RedisLock } from '../../../global/redis/redis-lock';
import {
  DATA_PURGE_LOCK_KEY,
  DataPurgeService,
} from './data-purge.service';

interface TestConfig {
  enabled: boolean;
  cron: string;
  retentionDays: number;
  sessionRetentionDays: number;
  lockTtlMs: number;
  batchSize: number;
  maxBatchesPerTick: number;
}

type TestMetrics = Pick<MetricsService, 'recordDataPurge' | 'observeDataPurgeDuration'>;

const createTransactionManagerFake = () => ({
  run: jest.fn(async (callback: () => Promise<void>): Promise<void> => callback()),
});

const createHarness = ({
  conversationIds = [],
  patientIds = [],
  clinicIds = [],
  sessionIds = [],
  batchSize = 2,
  maxBatchesPerTick = 50,
  metrics,
}: {
  conversationIds?: string[];
  patientIds?: string[];
  clinicIds?: string[];
  sessionIds?: string[];
  batchSize?: number;
  maxBatchesPerTick?: number;
  metrics?: TestMetrics;
} = {}) => {
  const remaining = {
    conversations: [...conversationIds],
    patients: [...patientIds],
    clinics: [...clinicIds],
    sessions: [...sessionIds],
  };
  const total = {
    conversations: conversationIds.length,
    patients: patientIds.length,
    clinics: clinicIds.length,
    sessions: sessionIds.length,
  };
  const deleted = {
    conversations: [] as string[],
    patients: [] as string[],
    clinics: [] as string[],
    sessions: [] as string[],
  };
  const repository = {
    findPurgeableConversationIds: jest.fn(
      async (_cutoff: Date, limit: number): Promise<string[]> =>
        remaining.conversations.splice(0, limit),
    ),
    findPurgeablePatientIds: jest.fn(
      async (_cutoff: Date, limit: number): Promise<string[]> =>
        remaining.patients.splice(0, limit),
    ),
    findPurgeableClinicIds: jest.fn(
      async (_cutoff: Date, limit: number): Promise<string[]> =>
        remaining.clinics.splice(0, limit),
    ),
    findPurgeableSessionIds: jest.fn(
      async (_sessionCutoff: Date, limit: number): Promise<string[]> =>
        remaining.sessions.splice(0, limit),
    ),
    countPurgeable: jest.fn(async (_cutoff: Date, _sessionCutoff: Date) => ({ ...total })),
    purgeConversations: jest.fn(async (ids: string[]): Promise<void> => {
      deleted.conversations.push(...ids);
    }),
    purgePatients: jest.fn(async (ids: string[]): Promise<void> => {
      deleted.patients.push(...ids);
    }),
    purgeClinics: jest.fn(async (ids: string[]): Promise<void> => {
      deleted.clinics.push(...ids);
    }),
    purgeSessions: jest.fn(async (ids: string[]): Promise<void> => {
      deleted.sessions.push(...ids);
    }),
  };
  const lock = {
    acquire: jest.fn(
      async (_key: string, _ttlMs: number): Promise<string | null> => 'test-lock-token',
    ),
    extend: jest.fn(
      async (_key: string, _token: string, _ttlMs: number): Promise<boolean> => true,
    ),
    release: jest.fn(async (_key: string, _token: string): Promise<void> => undefined),
  };
  const config: TestConfig = {
    enabled: true,
    cron: '0 18 * * *',
    retentionDays: 30,
    sessionRetentionDays: 30,
    lockTtlMs: 60_000,
    batchSize,
    maxBatchesPerTick,
  };
  const txManager = createTransactionManagerFake();
  const subject = new DataPurgeService(
    repository as unknown as DataPurgeRepository,
    txManager as never,
    lock as unknown as RedisLock,
    config as never,
    metrics as MetricsService | undefined,
  );
  return { subject, repository, lock, config, txManager, deleted };
};

describe('DataPurgeService — 이슈 #473 배치 드레인', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('U1: 상한과 같은 수가 뽑히면 다음 배치를 이어 돌아 바닥까지 지운다', async () => {
    const { subject, repository } = createHarness({
      conversationIds: ['c1', 'c2', 'c3', 'c4', 'c5'],
    });

    const result = await subject.purge();

    expect(repository.purgeConversations.mock.calls).toEqual([
      [['c1', 'c2']],
      [['c3', 'c4']],
      [['c5']],
    ]);
    expect(result).toMatchObject({ conversations: 5, deferred: 0, skipped: false });
  });

  it('U2: 네 축 모두 상한 미만이면 배치를 한 번만 돈다', async () => {
    const { subject, repository, lock } = createHarness({
      conversationIds: ['c1'],
      patientIds: ['p1'],
    });

    await subject.purge();

    expect(repository.findPurgeableConversationIds).toHaveBeenCalledTimes(1);
    expect(repository.findPurgeablePatientIds).toHaveBeenCalledTimes(1);
    expect(lock.extend).not.toHaveBeenCalled();
  });

  it('U3: 최대 배치 수에 닿으면 멈추고 남은 수를 deferred와 경고 로그에 남긴다', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { subject, repository } = createHarness({
      conversationIds: ['c1', 'c2', 'c3', 'c4', 'c5'],
      maxBatchesPerTick: 2,
    });

    const result = await subject.purge();

    expect(repository.purgeConversations).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ conversations: 4, deferred: 1 });
    expect(JSON.stringify(warnSpy.mock.calls)).toContain('1');
  });

  it('U4: 배치 사이 락 연장이 실패하면 첫 배치만 커밋하고 락을 해제한다', async () => {
    const { subject, repository, lock, config } = createHarness({
      conversationIds: ['c1', 'c2', 'c3', 'c4', 'c5'],
    });
    lock.extend.mockResolvedValue(false);

    const result = await subject.purge();

    expect(lock.extend.mock.calls).toEqual([
      [DATA_PURGE_LOCK_KEY, 'test-lock-token', config.lockTtlMs],
    ]);
    expect(repository.purgeConversations).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ conversations: 2, deferred: 3 });
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('U5: 배치마다 별도 트랜잭션을 사용하고 총수 조회와 락 획득·해제는 틱당 한 번이다', async () => {
    const { subject, repository, txManager, lock, config } = createHarness({
      conversationIds: ['c1', 'c2', 'c3', 'c4', 'c5'],
    });

    await subject.purge();

    expect(txManager.run).toHaveBeenCalledTimes(3);
    expect(repository.countPurgeable).toHaveBeenCalledTimes(1);
    expect(lock.acquire).toHaveBeenCalledTimes(1);
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(lock.extend.mock.calls).toEqual([
      [DATA_PURGE_LOCK_KEY, 'test-lock-token', config.lockTtlMs],
      [DATA_PURGE_LOCK_KEY, 'test-lock-token', config.lockTtlMs],
    ]);
    // 연장은 앞 배치가 끝난 뒤, 다음 후보 산출 전에 있어야 한다.
    for (let index = 0; index < 2; index += 1) {
      const extensionOrder = lock.extend.mock.invocationCallOrder[index];
      expect(extensionOrder).toBeGreaterThan(
        repository.purgeConversations.mock.invocationCallOrder[index],
      );
      expect(extensionOrder).toBeLessThan(
        repository.findPurgeableConversationIds.mock.invocationCallOrder[index + 1],
      );
    }
  });

  it('U6: 환자 축만 상한에 닿아도 다음 배치를 돌고 대화 누계를 보존한다', async () => {
    const { subject, repository } = createHarness({
      conversationIds: ['c1'],
      patientIds: ['p1', 'p2', 'p3'],
    });

    const result = await subject.purge();

    expect(repository.purgePatients.mock.calls).toEqual([[['p1', 'p2']], [['p3']]]);
    expect(
      repository.purgeConversations.mock.calls.filter(([ids]) => ids.length > 0),
    ).toEqual([[['c1']]]);
    expect(result).toMatchObject({ patients: 3, conversations: 1, deferred: 0 });
  });

  it('U7: 두 번째 배치 실패는 같은 예외와 failed 메트릭을 남기고 이전 삭제는 보존한다', async () => {
    const metrics = {
      recordDataPurge: jest.fn(),
      observeDataPurgeDuration: jest.fn(),
    };
    const { subject, repository, txManager, lock, deleted } = createHarness({
      conversationIds: ['c1', 'c2', 'c3', 'c4', 'c5'],
      metrics,
    });
    const error = new Error('두 번째 대화 파기 배치 실패');
    repository.purgeConversations
      .mockImplementationOnce(async (ids: string[]): Promise<void> => {
        deleted.conversations.push(...ids);
      })
      .mockRejectedValueOnce(error);

    await expect(subject.purge()).rejects.toBe(error);

    expect(txManager.run).toHaveBeenCalledTimes(2);
    expect(metrics.recordDataPurge).toHaveBeenCalledWith('conversation', 'failed');
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(deleted.conversations).toEqual(['c1', 'c2']);
  });
});
