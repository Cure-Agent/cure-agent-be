import { registerAs } from '@nestjs/config';

export const alertConfig = registerAs('alert', () => ({
  /** Discord/Slack webhook URL. 비어 있으면 알림 비활성. */
  webhookUrl: process.env.ALERT_WEBHOOK_URL || null,
  /**
   * 실제 발송 대상 목록 (docs/specs/15).
   * 구현 단계에서 resolveAlertTargets(process.env)로 채운다 — 스텁 단계에선 빈 배열이라 현행 동작이 유지된다.
   */
  webhookUrls: [] as string[],
}));
