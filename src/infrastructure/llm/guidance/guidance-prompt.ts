/**
 * 참고안 구조화 프롬프트 (docs/specs/33).
 * qa-v5(prompt-builder.ts)와 **분리된 축**이다 — QA 근거 계약·groundedness 전후 비교를
 * 오염시키지 않으려면 버전도 관측도 따로 서야 한다.
 */
import { GuidanceStructureInput } from './guidance-structurer.port';

/** ClinicalGuidance.composerVersion 기록값 (구조화 경로) */
export const GUIDANCE_PROMPT_VERSION = 'guidance-v0-stub';

export const GUIDANCE_SYSTEM_PROMPT = '';

export function buildGuidanceUserPrompt(_input: GuidanceStructureInput): string {
  throw new Error('not implemented');
}
