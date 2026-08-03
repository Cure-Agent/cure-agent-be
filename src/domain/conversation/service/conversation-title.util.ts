/**
 * 첫 질문에서 대화 제목을 만든다 (규칙 기반 — LLM 미사용).
 *
 * 이 제품의 첫 메시지는 곧 질문 주제라("만성 요통에 침 치료가 효과적인가요?") 다듬기만 해도
 * 제목이 선다. 규칙을 일부러 단순하게 두는 이유는 0015 마이그레이션이 기존 대화를 소급
 * 백필하며 같은 규칙을 SQL로 한 번 더 구현하기 때문이다 — 규칙이 복잡해지면 두 구현이 어긋난다.
 *
 * 나중에 LLM 요약으로 올릴 경우 이 함수는 그대로 폴백으로 남는다(프로바이더 소진·타임아웃).
 */

/**
 * 목록 표시 폭(사이드바 16rem)은 이보다 훨씬 좁아 CSS가 다시 자른다. 그런데도 40자를 남기는
 * 이유는 제목이 검색 대상(GET /conversations?query=, title ILIKE)이기 때문이다 — 너무 짧게
 * 자르면 검색으로 못 찾는 대화가 생긴다. CreateConversationRequestDto의 상한 100자 안이다.
 */
export const AUTO_TITLE_MAX_LENGTH = 40;

/** 다듬은 결과가 비면 null — 제목을 건드리지 않고 기본 제목을 유지한다는 뜻이다. */
export function deriveConversationTitle(content: string): string | null {
  // 개행·연속 공백은 목록에서 어차피 한 줄로 눌리므로 미리 한 칸으로 접는다
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return null;

  // 코드포인트 단위로 자른다 — String.length(UTF-16)로 자르면 이모지가 반 토막 나고,
  // Postgres left()/char_length()의 세는 단위와도 어긋나 백필 결과가 달라진다.
  const codePoints = [...normalized];
  if (codePoints.length <= AUTO_TITLE_MAX_LENGTH) return normalized;
  return `${codePoints.slice(0, AUTO_TITLE_MAX_LENGTH).join('')}…`;
}
