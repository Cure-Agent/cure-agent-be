/**
 * qa-v3·qa-v4에서 추가된 프롬프트 규칙.
 * 전부 실측으로 확인된 결함을 막는다 — 모델을 바꿔도, **프롬프트 버전이 올라가도**
 * 유지되어야 한다. 현행 버전 핀은 prompt-rules-qa-v5.spec(docs/specs/32 기준 1)이
 * 갖는다 — 두 곳에서 핀을 잡으면 버전을 올릴 때마다 양쪽을 고쳐야 한다.
 */
import { buildPrompt } from './prompt-builder';
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

describe('프롬프트 규칙 (qa-v3·qa-v4)', () => {
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

  it('마커의 직접 지지 원칙을 지시한다 (qa-v4)', () => {
    // groundedness 실측(docs/rag-eval, 2026-08-02): miscite·실질 무근거가 전부
    // 「근거 내용 소개·나열의 귀속 과잉」이었다 — 처방·수치를 종합해 나열하며
    // 그 항목이 없는 근거에 마커를 달았다. miscite는 인용이 달려 검증된 것처럼
    // 보이는 안전 최우선 결함이라, 불확실하면 마커를 빼는 쪽으로 기울인다.
    expect(system).toContain('직접 서술한 내용에만 단다');
    expect(system).toContain('각 근거가 모두 그 문장을 지지할 때만');
    expect(system).toContain('종합해 만든 목록이나 결론에는');
  });
});
