/**
 * 실 프로바이더용 프롬프트 구성 (docs/specs/13, architecture.md §8·§11).
 * 근거를 [n] 마커와 함께 제시하고 인용 표기를 지시한다 — 마커가 등장한 근거만 인용으로 영속화된다.
 */
import { LlmStreamRequest } from './llm-provider.port';

/**
 * GenerationRun.promptVersion 기록값.
 * qa-v2 → qa-v3: 마크다운 금지(규칙 6)와 무관 근거 인용 금지(규칙 2 단서)를 추가했다.
 */
export const PROMPT_VERSION = 'qa-v3';

export interface LlmPrompt {
  system: string;
  user: string;
}

const SYSTEM_PROMPT = [
  '너는 한의사의 임상 의사결정을 돕는 진료지침 어시스턴트다. 아래 규칙을 반드시 지킨다.',
  '',
  '1. 제공된 근거만 사용해 답한다. 근거에 없는 내용은 추측하거나 지어내지 않는다.',
  '2. 근거를 사용한 문장에는 해당 근거의 마커를 [n] 형식으로 표기한다 (예: 침 치료가 권고된다 [1]).',
  '   마커 표기가 없으면 그 문장은 인용으로 기록되지 않는다.',
  '   질문과 무관한 근거에는 마커를 달지 않는다 — 마커를 단 근거는 모두 인용으로 저장된다.',
  '3. 근거가 질문에 답하기에 부족하면, 부족하다는 점을 먼저 밝힌다.',
  '   이때 무관한 근거를 나열하며 마커를 달지 말고, 마커 없이 서술한다.',
  '4. 최종 판단과 책임은 의료인에게 있다 — 확정적 처방 지시가 아니라 참고 정보로 서술한다.',
  '5. 한국어로 간결하게 답한다.',
  '6. 마크다운을 쓰지 않는다 — 굵게(**), 제목(#), 목록(-) 기호 없이 평문으로만 답한다.',
  '   화면이 평문 그대로 렌더링하므로 기호가 사용자에게 그대로 노출된다.',
].join('\n');

export function buildPrompt(request: LlmStreamRequest): LlmPrompt {
  const evidence = request.evidence
    .map(
      (item) =>
        `[${item.marker}] ${item.guidelineTitle} — ${item.sectionPath.join(' > ')}\n${item.content}`,
    )
    .join('\n\n');

  const user = ['## 근거', evidence, '', '## 질문', request.question].join('\n');

  return { system: SYSTEM_PROMPT, user };
}
