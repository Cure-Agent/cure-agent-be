import { AUTO_TITLE_MAX_LENGTH, deriveConversationTitle } from './conversation-title.util';

describe('conversation-title.util', () => {
  it('짧은 질문은 그대로 제목이 된다', () => {
    expect(deriveConversationTitle('만성 요통에 침 치료가 효과적인가요?')).toBe(
      '만성 요통에 침 치료가 효과적인가요?',
    );
  });

  it('개행·연속 공백은 한 칸으로 접는다 — 목록은 한 줄로 렌더된다', () => {
    expect(deriveConversationTitle('  만성 요통\n\n침 치료   효과 ')).toBe(
      '만성 요통 침 치료 효과',
    );
  });

  it(`${AUTO_TITLE_MAX_LENGTH}자를 넘으면 잘리고 말줄임표가 붙는다`, () => {
    const long = '가'.repeat(AUTO_TITLE_MAX_LENGTH + 10);
    expect(deriveConversationTitle(long)).toBe(`${'가'.repeat(AUTO_TITLE_MAX_LENGTH)}…`);
  });

  it('경계값: 정확히 상한이면 자르지 않는다', () => {
    const exact = '가'.repeat(AUTO_TITLE_MAX_LENGTH);
    expect(deriveConversationTitle(exact)).toBe(exact);
  });

  it('코드포인트 단위로 잘라 이모지를 반 토막 내지 않는다', () => {
    const title = deriveConversationTitle('🩺'.repeat(AUTO_TITLE_MAX_LENGTH + 5));
    expect(title).toBe(`${'🩺'.repeat(AUTO_TITLE_MAX_LENGTH)}…`);
    expect(title).not.toContain('�');
  });

  it('공백뿐인 내용은 null — 기본 제목을 그대로 둔다', () => {
    expect(deriveConversationTitle('   \n\t ')).toBeNull();
    expect(deriveConversationTitle('')).toBeNull();
  });
});
