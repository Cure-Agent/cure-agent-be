/**
 * 첫 질문에서 대화 제목을 만든다 (규칙 기반 — LLM 미사용).
 *
 * 이 제품의 첫 메시지는 곧 질문 주제라("만성 요통에 침 치료가 효과적인가요?") 다듬기만 해도
 * 제목이 선다. 규칙을 일부러 단순하게 두는 이유는 0015·0029·0030 마이그레이션이 기존 대화를 소급
 * 백필하며 같은 규칙을 SQL로 다시 구현하기 때문이다 — 규칙이 복잡해지면 구현들이 어긋난다.
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

/**
 * 환자 대화 제목에서 케이스 라벨과 질문을 가르는 구분자 (docs/specs/56). 가운뎃점(U+00B7)은 라벨이
 * 어디서 끝나는지를 사람과 검색 양쪽에 남긴다 — 0030 백필이 같은 문자열을 SQL로 다시 쓴다.
 */
export const CASE_LABEL_SEPARATOR = ' · ';

/**
 * 환자 대화(PATIENT_GUIDANCE)의 자동 제목 — 케이스 라벨이 질문 앞에 남는다 (docs/specs/56).
 *
 * 질문만 쓰면 목록에서 환자를 알아볼 수 없다: 목록 요약에는 라벨이 없고(`patientId`뿐) 대화 검색은
 * `title ILIKE`라, 라벨이 빠지면 알아보는 축과 검색 축이 함께 사라진다. 게다가 환자 대화의 첫 질문은
 * 대개 추천 질의문 그대로라 질문만으로는 같은 제목이 줄지어 선다. 질문 부분의 규칙은 위와 같고,
 * 질문이 비면 null이다(질문 전 기본 제목인 라벨만 남는다).
 */
export function derivePatientConversationTitle(caseLabel: string, content: string): string | null {
  const question = deriveConversationTitle(content);
  return question === null ? null : `${caseLabel}${CASE_LABEL_SEPARATOR}${question}`;
}
