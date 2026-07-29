/**
 * e2e용 SSE 읽기 헬퍼 (docs/specs/22 수용 기준 6·7).
 *
 * 프레임 파싱 규칙은 test/conversation.e2e-spec.ts의 `parseSse`와 같다 — `data:` 프레임만 JSON으로
 * 읽는다. 다른 점은 **끝나지 않은 스트림**을 다룬다는 것이다: 잡 스트림은 잡이 끝나야 닫히는데,
 * 수용 기준 7·8·9는 잡이 도는 중간에 다른 요청을 보내야 성립하므로 supertest처럼 본문을 다 받고
 * 시작하는 방식으로는 그 시점을 잡을 수 없다. 그래서 `fetch` + reader로 프레임을 오는 대로 쌓고
 * (`openSseStream`), 이미 끝난 스트림은 기존처럼 본문 문자열을 한 번에 파싱한다(`parseSseEvents`).
 */

export interface SseEvent {
  eventType: string;
  [key: string]: unknown;
}

/**
 * SSE 프레임 하나 → 이벤트. 이벤트가 아니면 null이다.
 *
 * 하트비트 주석(`: ping`)과 `event:`·`id:` 같은 필드 줄은 버린다 — 주석은 연결 유지를 위한 것이라
 * 이벤트 순서 단언에 섞이면 「첫 이벤트가 job.snapshot」이 하트비트 타이밍에 따라 깨진다.
 */
function parseFrame(frame: string): SseEvent | null {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');
  if (data.length === 0) return null;
  return JSON.parse(data) as SseEvent;
}

/** 완결된 SSE 응답 본문(supertest `res.text`)을 이벤트 배열로 파싱한다 */
export function parseSseEvents(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((frame) => parseFrame(frame))
    .filter((event): event is SseEvent => event !== null);
}

export interface OpenSseOptions {
  /** 인증 쿠키 — SSE는 GET이라 EventSource와 같은 경로로 쿠키만 실으면 된다 (§22) */
  cookie?: string;
  /** 연결(헤더 수신)까지의 상한 */
  timeoutMs?: number;
}

export interface SseStream {
  /** HTTP 상태 — 401·403 검증도 이 헬퍼로 할 수 있다 */
  readonly status: number;
  readonly contentType: string;
  /** 지금까지 받은 이벤트 (수신되는 대로 늘어난다) */
  readonly events: SseEvent[];
  /** 조건에 맞는 이벤트가 올 때까지 기다린다. 이미 받은 것 중에 있으면 즉시 반환한다 */
  waitFor(match: string | ((event: SseEvent) => boolean), timeoutMs?: number): Promise<SseEvent>;
  /** 서버가 스트림을 닫을 때까지 기다린 뒤 전체 이벤트를 돌려준다 */
  untilClosed(timeoutMs?: number): Promise<SseEvent[]>;
  /** 클라이언트에서 끊는다 — 잡은 구독자와 무관하게 계속 돈다(§22) */
  close(): void;
}

/**
 * SSE 엔드포인트에 붙어 프레임을 오는 대로 쌓는다.
 *
 * @param url 절대 URL — `await app.listen(0)` 후 `app.getUrl()`로 만든다
 *   (supertest는 응답 완료 시점에 서버를 닫으므로 스트림을 열어둔 채 다른 요청을 보낼 수 없다).
 */
export async function openSseStream(
  url: string,
  options: OpenSseOptions = {},
): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: {
      Accept: 'text/event-stream',
      ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
    },
    signal: controller.signal,
  });

  const events: SseEvent[] = [];
  const waiters: (() => void)[] = [];
  let closed = false;

  const notify = (): void => {
    waiters.splice(0).forEach((wake) => wake());
  };

  const drain = (async () => {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Nest의 @Sse는 프레임을 빈 줄로 끊는다 — 청크 경계가 프레임 경계와 다르므로 버퍼에 모은다
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const event = parseFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (event) events.push(event);
          boundary = buffer.indexOf('\n\n');
        }
        notify();
      }
    } catch (error) {
      // close()로 끊은 abort는 정상 종료다 — 그 외의 오류만 드러낸다
      if (!closed) throw error;
    } finally {
      closed = true;
      notify();
    }
  })();
  // 스트림을 끝까지 기다리지 않는 테스트에서 unhandled rejection이 되지 않게 붙잡아 둔다
  drain.catch(() => undefined);

  const waitFor = (
    match: string | ((event: SseEvent) => boolean),
    timeoutMs = 10_000,
  ): Promise<SseEvent> => {
    const matches = typeof match === 'string' ? (e: SseEvent) => e.eventType === match : match;
    const found = (): SseEvent | undefined => events.find((event) => matches(event));

    const already = found();
    if (already) return Promise.resolve(already);

    return new Promise<SseEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `SSE 이벤트를 ${timeoutMs}ms 안에 받지 못했습니다. 받은 이벤트: ` +
              `[${events.map((event) => event.eventType).join(', ')}]`,
          ),
        );
      }, timeoutMs);
      const wake = (): void => {
        const event = found();
        if (event) {
          clearTimeout(timer);
          resolve(event);
          return;
        }
        if (closed) {
          clearTimeout(timer);
          reject(
            new Error(
              '기다리던 이벤트 없이 스트림이 닫혔습니다. 받은 이벤트: ' +
                `[${events.map((each) => each.eventType).join(', ')}]`,
            ),
          );
          return;
        }
        waiters.push(wake);
      };
      waiters.push(wake);
    });
  };

  const untilClosed = async (timeoutMs = 30_000): Promise<SseEvent[]> => {
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`SSE 스트림이 ${timeoutMs}ms 안에 닫히지 않았습니다.`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([drain, guard]);
    } finally {
      clearTimeout(timer);
    }
    return events;
  };

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    events,
    waitFor,
    untilClosed,
    close: () => {
      closed = true;
      controller.abort();
    },
  };
}
