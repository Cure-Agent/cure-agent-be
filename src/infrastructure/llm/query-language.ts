/**
 * 입력 언어 판정 (docs/specs/42).
 *
 * **검색 번역 여부에만 쓴다** — 표시 언어는 요청의 `responseLang`이 정하므로 이 판정이
 * 틀려도 화면이 깨지지 않는다. 답변 언어를 여기서 추론하지 않는 이유는 스펙 판단표에 있다:
 * FE가 입력 언어에서 유도해 실어 보내야 예시 질의문 클릭(표시 문장 = 전송 문장)과 어긋나지 않는다.
 */
import { SupportedLang } from './translation/translator.port';

/**
 * 한글로 판정하는 최소 비율. 임상 질의는 「ADHD 소아·청소년에서…」처럼 라틴 문자가 섞이므로
 * 과반을 요구하면 한국어 질의가 영어로 오판되고, 그러면 **번역이 필요 없는 질의에 번역이 붙어
 * 기준 1·2(한국어 경로 무변경)가 깨진다.** 낮게 잡아 한국어 쪽으로 기울인다.
 */
const HANGUL_RATIO = 0.2;

const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/g;
const LETTER = /[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z]/g;

export function detectQueryLanguage(text: string): SupportedLang {
  const letters = text.match(LETTER)?.length ?? 0;
  // 숫자·기호뿐인 입력은 번역할 것이 없다 — 한국어로 보아 오늘 경로를 그대로 태운다
  if (letters === 0) return 'ko';

  const hangul = text.match(HANGUL)?.length ?? 0;
  return hangul / letters >= HANGUL_RATIO ? 'ko' : 'en';
}
