import { registerAs } from '@nestjs/config';

/**
 * 소프트 삭제분 파기 설정 (docs/specs/34).
 *
 * **기본값은 꺼짐이다** — `guideline-scan.config.ts`와 같은 이유(§26 기준 31): 켜짐이 기본이면
 * 로컬·CI가 시간에 의존하고, 여기서는 그 대가가 더 크다. 이 크론은 행을 **되돌릴 수 없게**
 * 지우기 때문이다. 프로덕션 compose가 명시적으로 켠다.
 *
 * 크론식 기본값 `0 18 * * *`는 **UTC 기준 = 03:00 KST**다. 개정 감지 스캔(19시 UTC)과 겹치지
 * 않도록 한 시간 앞에 둔다 — 둘 다 Redis 락을 쓰지만 서로 다른 키라 배타는 아니고, 같은 시각에
 * 몰아 DB를 동시에 두드릴 이유가 없다.
 */
export const dataPurgeConfig = registerAs('dataPurge', () => ({
  enabled: process.env.DATA_PURGE_ENABLED === 'true',
  cron: process.env.DATA_PURGE_CRON ?? '0 18 * * *',
  /**
   * 소프트 삭제 후 물리 삭제까지의 유예(일). 이 값은 **상수가 아니라 설정이다** — 저장물이
   * 법정 보존 대상인지의 판단이 뒤집혀도 값만 바꾸면 되도록 스펙이 의도적으로 파라미터화했다.
   */
  retentionDays: Number(process.env.DATA_PURGE_RETENTION_DAYS ?? 30),
  /**
   * refresh 세션 유예(일) — **스텁이다**(docs/specs/39 구현에서 채운다).
   * 위 `retentionDays`와 **별도 축**이다: 임상 데이터 유예는 법정 보존 판단이 뒤집히면 위로만
   * 움직이는데(예: 3650일), 공유하면 refresh 토큰 해시가 그만큼 남는다.
   */
  sessionRetentionDays: 0,
  /** 락 TTL — 대상 산출 구간에 맞춘 값이며 삭제 소요와 무관하다 (§26 규약) */
  lockTtlMs: Number(process.env.DATA_PURGE_LOCK_TTL_MS ?? 60_000),
  /** 한 틱에 파기할 뿌리 행 수 상한. 초과분은 다음 틱으로 남기고 남긴 수를 로그로 남긴다 */
  batchSize: Number(process.env.DATA_PURGE_BATCH_SIZE ?? 200),
}));
