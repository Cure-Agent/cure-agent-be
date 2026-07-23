import { registerAs } from '@nestjs/config';

export const alertConfig = registerAs('alert', () => ({
  /** Discord/Slack webhook URL. 비어 있으면 알림 비활성. */
  webhookUrl: process.env.ALERT_WEBHOOK_URL || null,
}));
