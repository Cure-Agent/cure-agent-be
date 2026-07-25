/**
 * 알림 대상 webhook URL 목록 해석 (docs/specs/15).
 * ALERT_WEBHOOK_URLS(콤마 구분) + ALERT_WEBHOOK_URL(하위호환)을 합치고 중복을 제거한다.
 */

export function resolveAlertTargets(env: NodeJS.ProcessEnv): string[] {
  const multi = (env.ALERT_WEBHOOK_URLS ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);

  const legacy = env.ALERT_WEBHOOK_URL?.trim();
  if (legacy) multi.push(legacy);

  // ALERT_WEBHOOK_URLS 순서를 우선하고 뒤에 오는 중복은 버린다
  return [...new Set(multi)];
}
