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
export function structureWithTimeout(
  _structurer: GuidanceStructurer,
  _input: GuidanceStructureInput,
  _options: StructureWithTimeoutOptions = {},
): Promise<GuidanceStructureResult | null> {
  throw new Error('not implemented');
}
