// docs/specs/16 수용 기준 1~4 동결 테스트 — 구현 중 수정 금지
import Redis from 'ioredis';
import { ServiceException } from '../global/common/exception/service.exception';
import { TransactionManager } from '../global/database/transaction-manager';
import { ReadinessService } from './readiness.service';

describe('ReadinessService', () => {
  it('DB와 Redis가 모두 정상이면 ready와 의존성 상태를 반환한다', async () => {
    const txManager = {
      conn: { execute: jest.fn().mockResolvedValue([]) },
    } as unknown as TransactionManager;
    const redis = {
      ping: jest.fn().mockResolvedValue('PONG'),
    } as unknown as Redis;
    const service = new ReadinessService(txManager, redis);

    await expect(service.check()).resolves.toEqual({
      status: 'ready',
      dependencies: {
        database: 'up',
        redis: 'up',
      },
    });
  });

  it('DB 조회가 실패하면 database만 down인 SERVICE_NOT_READY를 던진다', async () => {
    const txManager = {
      conn: { execute: jest.fn().mockRejectedValue(new Error('down')) },
    } as unknown as TransactionManager;
    const redis = {
      ping: jest.fn().mockResolvedValue('PONG'),
    } as unknown as Redis;
    const service = new ReadinessService(txManager, redis);

    try {
      await service.check();
      throw new Error('ServiceException이 발생해야 한다');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceException);
      const serviceError = error as ServiceException;
      expect(serviceError.code).toBe('SERVICE_NOT_READY');
      expect(serviceError.data).toEqual({
        database: 'down',
        redis: 'up',
      });
    }
  });

  it('Redis ping이 실패하면 redis만 down인 SERVICE_NOT_READY를 던진다', async () => {
    const txManager = {
      conn: { execute: jest.fn().mockResolvedValue([]) },
    } as unknown as TransactionManager;
    const redis = {
      ping: jest.fn().mockRejectedValue(new Error('down')),
    } as unknown as Redis;
    const service = new ReadinessService(txManager, redis);

    try {
      await service.check();
      throw new Error('ServiceException이 발생해야 한다');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceException);
      const serviceError = error as ServiceException;
      expect(serviceError.code).toBe('SERVICE_NOT_READY');
      expect(serviceError.data).toEqual({
        database: 'up',
        redis: 'down',
      });
    }
  });

  it('DB 조회와 Redis ping이 모두 실패하면 두 의존성이 모두 down이다', async () => {
    const txManager = {
      conn: { execute: jest.fn().mockRejectedValue(new Error('down')) },
    } as unknown as TransactionManager;
    const redis = {
      ping: jest.fn().mockRejectedValue(new Error('down')),
    } as unknown as Redis;
    const service = new ReadinessService(txManager, redis);

    try {
      await service.check();
      throw new Error('ServiceException이 발생해야 한다');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceException);
      const serviceError = error as ServiceException;
      expect(serviceError.code).toBe('SERVICE_NOT_READY');
      expect(serviceError.data).toEqual({
        database: 'down',
        redis: 'down',
      });
    }
  });
});
