/**
 * 실 프로바이더용 프롬프트 구성 (docs/specs/13, architecture.md §8·§11).
 * 근거를 [n] 마커와 함께 제시하고 인용 표기를 지시한다 — 마커가 등장한 근거만 인용으로 영속화된다.
 */
import { LlmStreamRequest } from './llm-provider.port';

/** GenerationRun.promptVersion 기록값 — 실 프롬프트 도입으로 qa-v1에서 상향 */
export const PROMPT_VERSION = 'qa-v2';

export interface LlmPrompt {
  system: string;
  user: string;
}

export function buildPrompt(_request: LlmStreamRequest): LlmPrompt {
  throw new Error('buildPrompt 미구현 (docs/specs/13)');
}
