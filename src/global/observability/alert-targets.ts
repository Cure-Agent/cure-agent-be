/**
 * 알림 대상 webhook URL 목록 해석 (docs/specs/15).
 * ALERT_WEBHOOK_URLS(콤마 구분) + ALERT_WEBHOOK_URL(하위호환)을 합치고 중복을 제거한다.
 */

export function resolveAlertTargets(_env: NodeJS.ProcessEnv): string[] {
  throw new Error('resolveAlertTargets 미구현 (docs/specs/15)');
}
