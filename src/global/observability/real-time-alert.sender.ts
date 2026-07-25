import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { alertConfig } from '../config/alert.config';

export interface AlertEvent {
  title: string;
  detail?: string;
  traceId?: string;
}

/** 같은 알림이 장애 지속 중 요청마다 나가지 않도록 억제하는 창 (docs/specs/15) */
const DEDUPE_WINDOW_MS = 5 * 60_000;

/**
 * 5xx·LLM 장애 등을 Discord/Slack webhook으로 즉시 알린다 (architecture.md §14, docs/specs/15).
 * 알림 실패가 요청 처리에 영향을 주면 안 되므로 fire-and-forget으로 동작하고,
 * 한 채널의 실패는 다른 채널 전송을 막지 않는다.
 */
@Injectable()
export class RealTimeAlertSender {
  private readonly logger = new Logger(RealTimeAlertSender.name);
  /** dedupe 키 → 마지막 전송 시각. 단일 인스턴스 in-memory (Redis 공유는 P1) */
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    @Inject(alertConfig.KEY)
    private readonly config: ConfigType<typeof alertConfig>,
  ) {}

  send(event: AlertEvent): void {
    const targets = this.config.webhookUrls;
    if (targets.length === 0) return;

    if (this.suppressed(event)) {
      this.logger.debug(`알림 중복 억제: ${event.title}`);
      return;
    }

    const text = formatMessage(event);
    for (const url of targets) {
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(url, event, text)),
        signal: AbortSignal.timeout(3_000),
      }).catch((error: unknown) => {
        // 한 채널 실패를 삼켜 나머지 채널·요청 처리에 영향을 주지 않는다
        this.logger.warn(`알림 전송 실패(${url}): ${String(error)}`);
      });
    }
  }

  private suppressed(event: AlertEvent): boolean {
    const key = `${event.title} ${event.detail ?? ''}`;
    const now = Date.now();
    const last = this.lastSentAt.get(key);

    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return true;

    this.lastSentAt.set(key, now);
    return false;
  }
}

function formatMessage(event: AlertEvent): string {
  return [
    `🚨 **${event.title}**`,
    event.detail ? `> ${event.detail}` : null,
    event.traceId ? `> traceId: \`${event.traceId}\`` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** 채널이 이해하는 키로 보낸다 — Slack에 {content}를 보내면 invalid_payload로 조용히 실패한다 */
function buildPayload(url: string, event: AlertEvent, text: string): Record<string, unknown> {
  const host = hostOf(url);

  if (host === 'hooks.slack.com') return { text };
  if (host === 'discord.com' || host === 'discordapp.com') return { content: text };

  // 자체 수집기: 구조화 필드 + 사람이 읽을 텍스트를 함께 준다
  return { title: event.title, detail: event.detail, traceId: event.traceId, text };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
