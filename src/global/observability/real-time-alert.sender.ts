import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { alertConfig } from '../config/alert.config';

export interface AlertEvent {
  title: string;
  detail?: string;
  traceId?: string;
}

/**
 * 5xx·LLM 장애 등을 Discord/Slack webhook으로 즉시 알린다 (architecture.md §14).
 * 알림 실패가 요청 처리에 영향을 주면 안 되므로 fire-and-forget으로 동작한다.
 */
@Injectable()
export class RealTimeAlertSender {
  private readonly logger = new Logger(RealTimeAlertSender.name);

  constructor(
    @Inject(alertConfig.KEY)
    private readonly config: ConfigType<typeof alertConfig>,
  ) {}

  send(event: AlertEvent): void {
    const url = this.config.webhookUrl;
    if (!url) return;

    const lines = [
      `🚨 **${event.title}**`,
      event.detail ? `> ${event.detail}` : null,
      event.traceId ? `> traceId: \`${event.traceId}\`` : null,
    ].filter((l): l is string => l !== null);

    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n') }),
      signal: AbortSignal.timeout(3_000),
    }).catch((error: unknown) => {
      this.logger.warn(`알림 전송 실패: ${String(error)}`);
    });
  }
}
