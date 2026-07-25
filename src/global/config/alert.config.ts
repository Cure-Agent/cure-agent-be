import { registerAs } from '@nestjs/config';
import { resolveAlertTargets } from '../observability/alert-targets';

export const alertConfig = registerAs('alert', () => ({
  /** 하위호환 입력 (docs/specs/15 — 실제 발송 대상은 webhookUrls다) */
  webhookUrl: process.env.ALERT_WEBHOOK_URL || null,
  /** 발송 대상 목록. 비어 있으면 알림 비활성. */
  webhookUrls: resolveAlertTargets(process.env),
}));
