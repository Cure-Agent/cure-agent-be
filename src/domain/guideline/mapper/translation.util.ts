/**
 * 인용 번역의 사용 가능 판정 (docs/specs/42).
 *
 * 인용 카드가 번역을 보이려면 세 조건이 **모두** 참이어야 한다. 하나라도 어긋나면 키 자체를
 * 싣지 않는다 — 빈 문자열이나 null을 실으면 화면이 「번역이 있는데 비었다」와 「번역이 없다」를
 * 구분하지 못한다(기준 14).
 */
import { SupportedLang } from '../../../infrastructure/llm/translation/translator.port';
import { EvidenceChunkTranslationRow } from '../persistence/guideline.schema';

export interface UsableTranslation {
  content: string;
  titleTranslated?: string;
  /** 원문 경로와 같은 길이의 배열. 잡이 아직 채우지 않았으면 없다 (docs/specs/44) */
  sectionPathTranslated?: string[];
  translatorModel: string;
}

export function usableTranslation(
  translation: EvidenceChunkTranslationRow | null | undefined,
  chunkContentHash: string,
  responseLang: SupportedLang,
): UsableTranslation | null {
  // ① 근거 원문이 한국어다 — 한국어 답변에는 붙일 이유가 없다 (기준 16)
  if (responseLang === 'ko') return null;
  // ② 그 언어의 번역이 적재돼 있다 (기준 14)
  if (!translation || translation.lang !== responseLang) return null;
  // ③ 원문이 개정되지 않았다 — 해시가 갈리면 번역은 낡은 문장을 가리킨다 (기준 15·21)
  if (translation.sourceContentHash !== chunkContentHash) return null;

  return {
    content: translation.content,
    ...(translation.titleTranslated ? { titleTranslated: translation.titleTranslated } : {}),
    // 잡이 아직 채우지 않은 경로는 키 자체가 없다 — 고장이 아니라 범위다 (docs/specs/44 기준 11)
    ...(translation.sectionPathTranslated
      ? { sectionPathTranslated: translation.sectionPathTranslated }
      : {}),
    translatorModel: translation.translatorModel,
  };
}
