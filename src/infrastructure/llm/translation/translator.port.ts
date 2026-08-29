/**
 * 번역 포트 (docs/specs/42).
 *
 * `LlmProvider.streamAnswer`를 재사용하지 않는 이유는 §29·§33과 같다 — 그 계약은 근거 인용
 * 답변 전용이고(`{question, evidence}` + 스트리밍 + 답변가능성 판정), 번역은 **비스트리밍 단발
 * 호출**이다. 게이트가 켜진 구성에서는 `openai.provider`가 `response_format`을 답변 JSON
 * 스키마로 고정하므로 번역문을 그 스키마 안에 숨겨 꺼내야 하고, 지표에는 답변 생성 1건이 찍힌다.
 * 외부 유료 API라 **fake 치환 없이는 e2e 동결이 성립하지 않는다**(architecture.md §3 포트 기준).
 *
 * 질의 번역(EN→KO, 요청 경로)과 청크 번역(KO→EN, 배치)이 같은 외부 경계라 포트를 하나만 둔다 —
 * 방향은 인자다. spec 42 범위 표의 `query-translator.port.ts`를 이 이름으로 낸다.
 */

export const TRANSLATOR = Symbol('TRANSLATOR');

/** 지원 언어 — ko·en 둘뿐이다 (spec 42 Out of scope: 제3언어) */
export type SupportedLang = 'ko' | 'en';

export interface Translator {
  /** GenerationRun·번역 행 provenance에 기록되는 식별자 */
  readonly model: string;
  /**
   * 실패는 예외로 던진다. 리랭커(§29)와 달리 **폴백이 없다** — 질의 번역이 실패하면 원문으로
   * 검색하지 않고 스트림을 `LLM_UNAVAILABLE`로 끝낸다 (기준 7).
   */
  translate(text: string, target: SupportedLang): Promise<string>;
}
