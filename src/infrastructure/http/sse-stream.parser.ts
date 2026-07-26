/**
 * 프로바이더 응답(SSE) 프레임 파서 (docs/specs/13).
 * 청크 경계가 프레임 중간을 가르는 경우를 흡수해, 완성된 프레임만 순서대로 내보낸다.
 */

export interface SseFrame {
  /** `event:` 필드 (OpenAI는 미사용, Anthropic은 이벤트 타입 구분에 사용) */
  event: string | null;
  /** `data:` 필드들을 개행으로 이은 값 */
  data: string;
}

export async function* parseSseFrames(body: ReadableStream<Uint8Array>): AsyncIterable<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer = normalize(buffer + decoder.decode(value, { stream: true }));
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = toFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (frame) yield frame;
        boundary = buffer.indexOf('\n\n');
      }
    }

    // 종료 구분자 없이 끝난 마지막 프레임도 흘리지 않는다
    const tail = toFrame(normalize(buffer + decoder.decode()));
    if (tail) yield tail;
  } finally {
    // 소비 측이 중간에 멈춰도(폴백·abort) 남은 본문을 버려 소켓을 회수한다
    await reader.cancel().catch(() => undefined);
  }
}

function normalize(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n/g, '\n') : text;
}

function toFrame(raw: string): SseFrame | null {
  let event: string | null = null;
  const data: string[] = [];

  for (const line of raw.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue; // 빈 줄·주석(heartbeat)

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  if (event === null && data.length === 0) return null;
  return { event, data: data.join('\n') };
}
