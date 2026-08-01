/**
 * 실 프로바이더용 프롬프트 구성 (docs/specs/13, architecture.md §8·§11).
 * 근거를 [n] 마커와 함께 제시하고 인용 표기를 지시한다 — 마커가 등장한 근거만 인용으로 영속화된다.
 */
import { LlmStreamRequest } from './llm-provider.port';

/**
 * GenerationRun.promptVersion 기록값.
 * qa-v2 → qa-v3: 마크다운 금지(규칙 6)와 무관 근거 인용 금지(규칙 2 단서)를 추가했다.
 * qa-v3 → qa-v4: 마커 직접 지지 원칙(규칙 2 강화) — groundedness 실측(docs/rag-eval,
 * 2026-08-02)에서 miscite 5건·실질 무근거 4건이 전부 「근거 내용 소개·나열의 귀속 과잉」
 * 한 패턴이었다: 처방·수치를 종합해 나열하며 그 항목이 없는 근거에 마커를 달았다.
 */
export const PROMPT_VERSION = 'qa-v4';

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
  '   마커는 그 근거가 직접 서술한 내용에만 단다. 처방명·혈자리·수치·기간·횟수를 옮길 때는',
  '   그 항목이 실제로 적힌 근거의 마커만 달고, 한 문장에 [n][m]으로 여러 마커를 묶는 것은',
  '   각 근거가 모두 그 문장을 지지할 때만 한다. 여러 근거를 종합해 만든 목록이나 결론에는',
  '   마커를 달지 않는다 — 확실하지 않으면 마커를 빼는 쪽이 옳다.',
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
