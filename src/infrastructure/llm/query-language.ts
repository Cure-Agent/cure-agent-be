/**
 * 입력 언어 판정 (docs/specs/42).
 *
 * **검색 번역 여부에만 쓴다** — 표시 언어는 요청의 `responseLang`이 정하므로 이 판정이
 * 틀려도 화면이 깨지지 않는다. 답변 언어를 여기서 추론하지 않는 이유는 스펙 판단표에 있다:
 * FE가 입력 언어에서 유도해 실어 보내야 예시 질의문 클릭(표시 문장 = 전송 문장)과 어긋나지 않는다.
 *
 * **스텁** — 구현은 docs/specs/42 수용 기준을 통과시키며 채운다.
 */
import { SupportedLang } from './translation/translator.port';

export function detectQueryLanguage(_text: string): SupportedLang {
  throw new Error('not implemented');
}
