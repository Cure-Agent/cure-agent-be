// docs/specs/33 수용 기준 8 동결 테스트 — 구현 중 수정 금지

import { FakeGuidanceStructurer } from './fake-guidance-structurer';
import { createGuidanceStructurer } from './guidance-structurer.factory';
import { OpenAiGuidanceStructurer } from './openai-guidance-structurer';

describe('createGuidanceStructurer', () => {
  it('기준 8a: OPENAI_API_KEY가 없거나 빈 문자열이면 fake 구조화기를 반환한다', () => {
    const withoutKey = createGuidanceStructurer({});
    const withEmptyKey = createGuidanceStructurer({ OPENAI_API_KEY: '' });

    expect(withoutKey).toBeInstanceOf(FakeGuidanceStructurer);
    expect(withEmptyKey).toBeInstanceOf(FakeGuidanceStructurer);
  });

  it('기준 8b: 키가 있으면 기본적으로 활성 openai 구조화기를 반환한다', () => {
    const structurer = createGuidanceStructurer({
      OPENAI_API_KEY: 'sk-test',
    });

    expect(structurer).toBeInstanceOf(OpenAiGuidanceStructurer);
    expect(structurer.disabled).not.toBe(true);
  });

  it("기준 8c: 키가 있어도 GUIDANCE_STRUCTURE_ENABLED가 정확히 'false'면 비활성 표식이 있다", () => {
    const structurer = createGuidanceStructurer({
      OPENAI_API_KEY: 'sk-test',
      GUIDANCE_STRUCTURE_ENABLED: 'false',
    });

    expect(structurer.disabled).toBe(true);
  });

  it("기준 8d: 킬스위치는 정확히 'false'일 때만 발동한다", () => {
    const structurers = [
      createGuidanceStructurer({ OPENAI_API_KEY: 'sk-test' }),
      createGuidanceStructurer({
        OPENAI_API_KEY: 'sk-test',
        GUIDANCE_STRUCTURE_ENABLED: 'true',
      }),
      createGuidanceStructurer({
        OPENAI_API_KEY: 'sk-test',
        GUIDANCE_STRUCTURE_ENABLED: 'other',
      }),
    ];

    structurers.forEach((structurer) => {
      expect(structurer).toBeInstanceOf(OpenAiGuidanceStructurer);
      expect(structurer.disabled).not.toBe(true);
    });
  });
});
