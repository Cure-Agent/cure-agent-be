import { registerAs } from '@nestjs/config';

/**
 * 지침 개정 감지 스캔 설정 (docs/specs/26).
 *
 * **기본값은 꺼짐이다.** 켜짐이 기본이면 로컬·CI가 시간에 의존하고 실수로 NCKM을 두드린다 —
 * 프로덕션 compose가 명시적으로 켠다(기준 31).
 *
 * 크론식 기본값 `0 19 * * *`는 **UTC 기준 = 04:00 KST**다. 컨테이너에 TZ가 설정돼 있지 않아
 * 프로세스가 UTC로 돌고, NCKM 수정은 전부 한국 업무시간대(실측 09:47~15:06 KST)에 일어나므로
 * 그날의 변경이 모두 반영된 뒤 도는 시각이다.
 */
export const guidelineScanConfig = registerAs('guidelineScan', () => ({
  enabled: process.env.GUIDELINE_REVISION_SCAN_ENABLED === 'true',
  cron: process.env.GUIDELINE_REVISION_SCAN_CRON ?? '0 19 * * *',
  /**
   * 락 TTL. **스캔 구간(목록 POST 1회 + INSERT)에 맞춘 값이며 잡 소요와 무관하다** —
   * 잡은 락이 풀린 뒤에도 계속 돌고, 동시 실행 1개는 DB partial unique index가 지킨다(§22).
   */
  lockTtlMs: Number(process.env.GUIDELINE_REVISION_SCAN_LOCK_TTL_MS ?? 60_000),
}));
