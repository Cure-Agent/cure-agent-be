// docs/specs/33 수용 기준 7 동결 테스트 — 구현 중 수정 금지

import {
  GUIDANCE_PROMPT_VERSION,
  GUIDANCE_SYSTEM_PROMPT,
} from './guidance-prompt';

describe('spec 33: guidance-v1 프롬프트 계약', () => {
  it('기준 7a: 프롬프트 버전은 정확히 guidance-v1이다', () => {
    expect(GUIDANCE_PROMPT_VERSION).toBe('guidance-v1');
  });

  it('기준 7b: 인용 근거 밖의 새 임상 내용을 만들지 못하게 한다', () => {
    expect(GUIDANCE_SYSTEM_PROMPT).toContain('새 임상 내용을 만들지 않는다');
  });

  it('기준 7c: 모든 판단에 근거 마커와 환자 프로필 필드 두 다리를 함께 명시하게 한다', () => {
    expect(GUIDANCE_SYSTEM_PROMPT).toContain('근거 마커와');
    expect(GUIDANCE_SYSTEM_PROMPT).toContain(
      '환자 프로필 필드를 함께 명시한다',
    );
  });

  it('기준 7d: 근거 사이의 우선순위나 비교 우위를 새로 만들지 못하게 한다', () => {
    expect(GUIDANCE_SYSTEM_PROMPT).toContain(
      '우선순위·비교 우위를 만들지 않는다',
    );
  });
});
