// docs/specs/44 BE 수용 기준 2·13·15 동결 테스트 — 구현 중 수정 금지

import { renderTermbase } from '../terminology';
import {
  guidancePromptVersionFor,
  guidanceSystemPromptFor,
} from './guidance-prompt';

const ENGLISH_WRITING_RULE = /plain English|영어 평문/i;

describe('spec 44: 참고안 구조화 프롬프트 언어 계약', () => {
  it('[기준 2] 한국어 참고안의 프롬프트 버전은 guidance-v2 그대로다', () => {
    expect(guidancePromptVersionFor('ko')).toBe('guidance-v2');
  });

  it('[기준 13a] responseLang=en 프롬프트는 영어 평문으로 쓰라는 규칙을 담는다', () => {
    expect(guidanceSystemPromptFor('en')).toMatch(ENGLISH_WRITING_RULE);
  });

  it('[기준 13b] responseLang=ko 프롬프트에는 영문 작성 규칙이 없고 en 프롬프트와 갈린다', () => {
    const english = guidanceSystemPromptFor('en');
    const korean = guidanceSystemPromptFor('ko');

    expect(english).toMatch(ENGLISH_WRITING_RULE);
    expect(korean).not.toMatch(ENGLISH_WRITING_RULE);
    expect(korean).not.toBe(english);
  });

  it('[기준 15] 영문 구조화 프롬프트는 답변 생성과 같은 용어집 문자열을 싣는다', () => {
    const termbase = renderTermbase();

    expect(termbase.length).toBeGreaterThan(0);
    expect(guidanceSystemPromptFor('en')).toContain(termbase);
  });
});
