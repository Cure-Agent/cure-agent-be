// docs/specs/13 수용 기준 6 동결 테스트 — 구현 중 수정 금지
import { type LlmStreamRequest } from './llm-provider.port';
import { buildPrompt } from './prompt-builder';

const request: LlmStreamRequest = {
  question: '만성 요통 치료는 어떻게 하나요?',
  evidence: [
    {
      marker: 1,
      content: '만성 요통에 침 치료를 권고한다',
      guidelineTitle: '요통 진료지침',
      sectionPath: ['치료', '침치료'],
    },
    {
      marker: 2,
      content: '급성기에는 물리치료를 병행한다',
      guidelineTitle: '요통 진료지침',
      sectionPath: ['치료', '물리치료'],
    },
  ],
};

describe('buildPrompt', () => {
  it('근거 메타데이터와 질문 및 [n] 형식 인용 지시를 포함한다', () => {
    const prompt = buildPrompt(request);
    const fullPrompt = `${prompt.system}\n${prompt.user}`;

    expect(fullPrompt).toContain('[1]');
    expect(fullPrompt).toContain('[2]');
    expect(fullPrompt).toContain('요통 진료지침');
    expect(fullPrompt).toContain('치료');
    expect(fullPrompt).toContain('침치료');
    expect(fullPrompt).toContain('물리치료');
    expect(fullPrompt).toContain('만성 요통 치료는 어떻게 하나요?');
    expect(fullPrompt).toContain('[n]');
  });
});
