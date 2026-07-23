import type { Response } from 'express';

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * SSE 전송 규약 구현 (architecture.md §8).
 * - 봉투 미적용, data: JSON 프레임
 * - 15초 heartbeat 주석으로 프록시 idle timeout 방지
 * - X-Accel-Buffering: no
 */
export class SseStream {
  private readonly heartbeat: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly res: Response) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    this.heartbeat = setInterval(() => {
      if (!this.closed) this.res.write(': ping\n\n');
    }, HEARTBEAT_INTERVAL_MS);
  }

  send(event: Record<string, unknown>): void {
    if (this.closed) return;
    this.res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.res.end();
  }
}
