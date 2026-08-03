/**
 * 구조화 호출의 상한·폴백 경계 (docs/specs/33).
 *
 * 상한을 `AbortSignal.timeout`이 아니라 명시적 `setTimeout`으로 잡는 이유: 전자는 Node 내부
 * 타이머라 테스트의 fake timer가 개입하지 못해 상한 동작을 단위로 동결할 수 없다.
 */
import {
  GuidanceStructureInput,
  GuidanceStructureResult,
  GuidanceStructurer,
} from './guidance-structurer.port';

/** 실측 TTFT ~9.5s(§11)에 카드 1장 출력 여유를 더한 값 — 초과분은 참고안을 늦추느니 폴백한다 */
export const GUIDANCE_STRUCTURE_TIMEOUT_MS = 20_000;

export interface StructureWithTimeoutOptions {
  timeoutMs?: number;
  /** 클라이언트 abort — 끊긴 요청이 상한만큼 붙잡히지 않게 한다 */
  signal?: AbortSignal;
}

/**
 * 실패·타임아웃·abort를 **null 하나로 접는다** — 호출측은 폴백 여부만 알면 되고,
 * 참고안 구조화 실패가 답변 스트림 실패로 번지지 않는 것이 계약이다 (docs/specs/33 기준 3).
 */
export async function structureWithTimeout(
  structurer: GuidanceStructurer,
  input: GuidanceStructureInput,
  options: StructureWithTimeoutOptions = {},
): Promise<GuidanceStructureResult | null> {
  if (options.signal?.aborted) return null;

  const timeoutMs = options.timeoutMs ?? GUIDANCE_STRUCTURE_TIMEOUT_MS;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expiry = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        // 진행 중인 HTTP 호출을 끊는다 — 상한을 넘긴 응답은 어차피 쓰지 않는다
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });

    return await Promise.race([
      structurer.structure({ ...input, signal: controller.signal }),
      expiry,
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
