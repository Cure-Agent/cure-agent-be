import type Redis from 'ioredis';
import { RealTimeAlertSender } from '../observability/real-time-alert.sender';
import { TokenDenylistService } from './token-denylist.service';

describe('TokenDenylistService', () => {
  const alertSender = { send: jest.fn() } as unknown as RealTimeAlertSender;

  it('deny 후 isDenied가 true를 반환한다 (인메모리 fake)', async () => {
    const store = new Map<string, string>();
    const fakeRedis = {
      set: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      exists: jest.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    } as unknown as Redis;

    const service = new TokenDenylistService(fakeRedis, alertSender);
    await service.denyFamily('fam-1', 900);
    expect(await service.isDenied('fam-1')).toBe(true);
    expect(await service.isDenied('fam-2')).toBe(false);
    // TTL에 클록 스큐 여유분이 더해진다
    expect(fakeRedis.set).toHaveBeenCalledWith('auth:deny:fid:fam-1', '1', 'EX', 960);
  });

  it('Redis 장애 시 fail-open: 예외 없이 false + 알림은 중복 억제', async () => {
    const send = jest.fn();
    const broken = {
      set: jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      exists: jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    } as unknown as Redis;

    const service = new TokenDenylistService(broken, {
      send,
    } as unknown as RealTimeAlertSender);

    await expect(service.denyFamily('fam-1', 900)).resolves.toBeUndefined();
    await expect(service.isDenied('fam-1')).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1); // 5분 내 재실패는 알림 1회로 dedupe
  });
});
