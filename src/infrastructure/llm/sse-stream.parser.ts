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

export async function* parseSseFrames(
  _body: ReadableStream<Uint8Array>,
): AsyncIterable<SseFrame> {
  throw new Error('parseSseFrames 미구현 (docs/specs/13)');
}
