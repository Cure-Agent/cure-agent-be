// docs/specs/32 수용 기준 1~3 동결 테스트 — 구현 중 수정 금지
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

describe('spec 32: qa-v5 프롬프트 규칙', () => {
  const { system } = buildPrompt(request);

  it('기준 1: PROMPT_VERSION이 정확히 qa-v5다', () => {
    expect(PROMPT_VERSION).toBe('qa-v5');
  });

  it('기준 2a: 구체 임상 항목은 실제로 적힌 근거가 있을 때만 쓰도록 제한한다', () => {
    expect(system).toContain('처방명·혈자리·용량·기간·횟수');
    expect(system).toContain('실제로 적힌 근거가 있을 때만');
  });

  it('기준 2b: 근거에 없는 항목을 일반 지식으로 보충해 나열하지 못하게 한다', () => {
    expect(system).toContain('일반 지식으로 보충해 나열하지 않는다');
  });

  it('기준 3a: 여러 근거를 종합해 근거 어디에도 없는 새 판단을 만들지 못하게 한다', () => {
    expect(system).toContain('근거 어디에도 없는 새 판단을 만들지 않는다');
  });

  it('기준 3b: 우선순위·비교 판단은 근거가 직접 그렇게 서술할 때만 쓰도록 제한한다', () => {
    expect(system).toContain('근거가 직접 그렇게 서술할 때만');
  });
});
