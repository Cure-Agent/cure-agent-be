// docs/specs/34 수용 기준 14, 20, 21 동결 테스트 — 구현 중 수정 금지
import { Logger } from '@nestjs/common';
import { DataPurgeRepository } from '../repository/data-purge.repository';
import { RedisLock } from '../../../global/redis/redis-lock';
import {
  DATA_PURGE_LOCK_KEY,
  DataPurgeService,
} from './data-purge.service';

interface TestConfig {
  enabled: boolean;
  cron: string;
  retentionDays: number;
  lockTtlMs: number;
  batchSize: number;
}

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
  batchSize = 200,
}: {
  retentionDays?: number;
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
    // 세션 축은 docs/specs/39가 더했다. 이 스위트는 대화·환자·클리닉 축을 검증하므로
    // 세션은 빈 결과를 돌려주는 배선만 갖춘다 — 세션 축 자체의 단언은
    // data-purge-session-retention.spec.ts가 담당한다.
    findPurgeableSessionIds: jest.fn(
      async (_sessionCutoff: Date, _limit: number): Promise<string[]> => [],
    ),
    countPurgeable: jest.fn(
      async (
        _cutoff: Date,
        _sessionCutoff?: Date,
      ): Promise<{ conversations: number; patients: number }> => ({
        conversations: 0,
        patients: 0,
      }),
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
  const config: TestConfig = {
    enabled: true,
    cron: '0 18 * * *',
    retentionDays,
    lockTtlMs: 60_000,
    batchSize,
  };
  const transactionManager = createTransactionManagerFake();
  const subject = new DataPurgeService(
    repository as unknown as DataPurgeRepository,
    transactionManager as never,
    lock as unknown as RedisLock,
    config as never,
  );

  return { subject, repository, lock, config };
};

describe('DataPurgeService — docs/specs/34', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('기준 14: 주입 시각에서 retentionDays를 뺀 정확한 컷오프만 리포지토리에 넘긴다', async () => {
    jest.useFakeTimers();
    const now = new Date('2026-08-04T03:04:05.678Z');
    jest.setSystemTime(now);

    for (const retentionDays of [30, 7]) {
      const { subject, repository } = createHarness({ retentionDays });
      repository.countPurgeable.mockResolvedValue({ conversations: 1, patients: 1 });
      repository.findPurgeableConversationIds.mockResolvedValue(['conversation-cutoff-probe']);
      repository.findPurgeablePatientIds.mockResolvedValue(['patient-cutoff-probe']);
      await subject.purge();

      expect(repository.findPurgeableConversationIds).toHaveBeenCalledTimes(1);
      expect(repository.findPurgeablePatientIds).toHaveBeenCalledTimes(1);

      const conversationCutoff = repository.findPurgeableConversationIds.mock.calls[0][0];
      const patientCutoff = repository.findPurgeablePatientIds.mock.calls[0][0];
      const expected = now.getTime() - retentionDays * 24 * 60 * 60 * 1_000;

      expect(conversationCutoff).toBeInstanceOf(Date);
      expect(patientCutoff).toBeInstanceOf(Date);
      expect(conversationCutoff.getTime()).toBe(expected);
      expect(patientCutoff.getTime()).toBe(expected);
    }
  });

  it('기준 20: 락 획득 실패는 대상 산출을 전혀 하지 않고 skipped 결과를 돌려준다', async () => {
    const { subject, repository, lock, config } = createHarness();
    lock.acquire.mockResolvedValue(null);

    const result = await subject.purge();

    expect(lock.acquire).toHaveBeenCalledWith(DATA_PURGE_LOCK_KEY, config.lockTtlMs);
    expect(repository.findPurgeableConversationIds).not.toHaveBeenCalled();
    expect(repository.findPurgeablePatientIds).not.toHaveBeenCalled();
    expect(repository.countPurgeable).not.toHaveBeenCalled();
    expect(repository.purgeConversations).not.toHaveBeenCalled();
    expect(repository.purgePatients).not.toHaveBeenCalled();
    expect(result).toEqual({
      conversations: 0,
      patients: 0,
      sessions: 0, // docs/specs/39가 더한 축 — 정확 매칭을 유지하려 기대값에 명시한다
      deferred: 0,
      skipped: true,
    });
  });

  it('기준 21: 배치 상한만 삭제하고 초과분 수를 결과와 Logger에 남긴다', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { subject, repository } = createHarness({ batchSize: 2 });
    const candidates = ['conversation-1', 'conversation-2', 'conversation-3'];

    repository.countPurgeable.mockResolvedValue({ conversations: 3, patients: 0 });
    repository.findPurgeableConversationIds.mockImplementation(
      async (_cutoff: Date, limit: number): Promise<string[]> => candidates.slice(0, limit),
    );

    const result = await subject.purge();

    expect(repository.purgeConversations).toHaveBeenCalledTimes(1);
    expect(repository.purgeConversations).toHaveBeenCalledWith([
      'conversation-1',
      'conversation-2',
    ]);
    expect(result.conversations + result.patients).toBe(2);
    expect(result).toEqual({
      conversations: 2,
      patients: 0,
      sessions: 0, // docs/specs/39가 더한 축 — 정확 매칭을 유지하려 기대값에 명시한다
      deferred: 1,
      skipped: false,
    });

    const logged = JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls]);
    expect(logged).toContain('1');
  });

  it('docs/specs/36 기준 35: 주입 시각 기준 유예 미경과 클리닉은 파기하지 않는다', async () => {
    jest.useFakeTimers();
    const now = new Date('2026-08-04T03:04:05.678Z');
    jest.setSystemTime(now);
    const { subject, repository } = createHarness({ retentionDays: 30, batchSize: 10 });
    const clinics = [
      {
        id: 'clinic-expired-control',
        deletedAt: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1_000),
      },
      {
        id: 'clinic-within-retention',
        deletedAt: new Date(now.getTime() - 29 * 24 * 60 * 60 * 1_000),
      },
    ];

    repository.countPurgeable.mockResolvedValue({
      conversations: 0,
      patients: 0,
      clinics: 1,
    } as never);
    repository.findPurgeableClinicIds.mockImplementation(
      async (cutoff: Date, limit: number): Promise<string[]> =>
        clinics
          .filter((clinic) => clinic.deletedAt.getTime() <= cutoff.getTime())
          .slice(0, limit)
          .map((clinic) => clinic.id),
    );

    await subject.purge();

    expect(repository.findPurgeableClinicIds).toHaveBeenCalledTimes(1);
    const cutoff = repository.findPurgeableClinicIds.mock.calls[0][0];
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBe(now.getTime() - 30 * 24 * 60 * 60 * 1_000);
    expect(repository.purgeClinics).toHaveBeenCalledTimes(1);
    expect(repository.purgeClinics).toHaveBeenCalledWith(['clinic-expired-control']);
    expect(repository.purgeClinics.mock.calls[0][0]).not.toContain(
      'clinic-within-retention',
    );
  });
});
