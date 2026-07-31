/**
 * qa-v3에서 추가된 프롬프트 규칙.
 * 두 규칙 모두 실측으로 확인된 결함을 막는다 — 모델을 바꿔도 유지되어야 한다.
 */
import { PROMPT_VERSION, buildPrompt } from './prompt-builder';
import type { LlmStreamRequest } from './llm-provider.port';

const request: LlmStreamRequest = {
  question: '소아 야뇨증에 침 치료가 효과적인가요?',
  evidence: [
    {
      marker: 1,
      content: '성인 만성 요통 환자에게 침 치료를 권고한다',
      guidelineTitle: '요통 진료지침',
      sectionPath: ['치료', '침치료'],
    },
  ],
};

describe('프롬프트 규칙 (qa-v3)', () => {
  const { system } = buildPrompt(request);

  it('무관한 근거에 마커를 달지 말라고 지시한다', () => {
    // 마커를 단 근거는 전부 인용으로 영속화된다(conversation-stream.service의 usedMarkers).
    // 이 지시가 없으면 "근거 부족" 답변이 무관한 근거 전부를 인용으로 남겼다.
    expect(system).toContain('질문과 무관한 근거에는 마커를 달지 않는다');
    expect(system).toContain('마커 없이 서술한다');
  });

  it('마크다운을 금지한다', () => {
    // FE MessageBubble이 whitespace-pre-wrap 평문으로 렌더링해 기호가 그대로 노출된다.
    expect(system).toContain('마크다운을 쓰지 않는다');
  });

  it('규칙을 추가했으므로 promptVersion이 qa-v2에서 올라가 있다', () => {
    // GenerationRun.promptVersion으로 답변 품질 변화를 추적한다
    expect(PROMPT_VERSION).toBe('qa-v3');
  });
});
