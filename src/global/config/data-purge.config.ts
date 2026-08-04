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
   * refresh 세션 만료 후 물리 삭제까지의 유예(일) — docs/specs/39.
   *
   * 위 `retentionDays`와 **별도 축이며 서로를 참조하지 않는다.** 임상 데이터 유예를 파라미터로
   * 둔 이유는 「저장물이 법정 보존 대상인지의 판단이 뒤집힐 수 있어서」인데, 뒤집히면 그 값은
   * **위로만** 움직인다(예: 3650일). 공유하면 refresh 토큰 해시가 10년 남는다.
   *
   * 만료된 토큰은 이미 교환이 거부되므로(`auth.service.ts`의 expiresAt 검사), 이 유예가 곧
   * **재사용 감지 꼬리의 길이**다 — 이 기간에는 구 토큰 재사용이 family 폐기 + 알림으로 잡히고,
   * 지난 뒤에는 행이 없어 평범한 401이 된다.
   */
  sessionRetentionDays: Number(process.env.DATA_PURGE_SESSION_RETENTION_DAYS ?? 30),
  /** 락 TTL — 대상 산출 구간에 맞춘 값이며 삭제 소요와 무관하다 (§26 규약) */
  lockTtlMs: Number(process.env.DATA_PURGE_LOCK_TTL_MS ?? 60_000),
  /** 한 틱에 파기할 뿌리 행 수 상한. 초과분은 다음 틱으로 남기고 남긴 수를 로그로 남긴다 */
  batchSize: Number(process.env.DATA_PURGE_BATCH_SIZE ?? 200),
}));
