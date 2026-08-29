/**
 * 청크 번역 잡 (docs/specs/42).
 *
 * **번역이 없거나 stale한 ACTIVE 청크를 채우는 멱등 잡이다** — 최초 1회도, 신규 적재도, 개정도
 * 같은 코드가 처리한다. 개정이 들어오면 새 버전의 청크가 새 `content_hash`로 생기므로 자동으로
 * 미번역 상태가 되고 다음 실행이 주워간다. §26 개정 스케줄러에 훅을 걸 필요가 없다.
 *
 * **스텁** — 구현은 docs/specs/42 수용 기준을 통과시키며 채운다.
 */
import { Injectable } from '@nestjs/common';
import { SupportedLang } from '../../../infrastructure/llm/translation/translator.port';

/**
 * 1차 번역 대상 6주제 (docs/specs/42 실측표) — ACTIVE 7,154청크 중 655청크(9.2%)다.
 *
 * **제목 문자열로 직접 비교하지 않는다.** ACTIVE 63건 중 2건의 제목에 후행 탭이 있고 그중
 * 하나가 아래 ADHD인데, PostgreSQL `trim()`은 탭을 지우지 않는다(실측: `length = length(trim)`).
 * 대상 필터는 `btrim(title, E' \t\n\r')` 정규화 부분일치여야 한다(기준 20).
 */
export const DEMO_TRANSLATION_TARGETS: readonly string[] = [
  '골다공증',
  '주의력결핍',
  '류마티스 관절염',
  '만성 요통',
  '불면장애',
  '편두통',
];

export interface ChunkTranslationJobResult {
  /** 대상으로 잡힌 ACTIVE 청크 수 */
  targeted: number;
  /** 이번 실행이 새로 쓴 번역 행 수 */
  translated: number;
  /** 이미 최신 번역이 있어 건너뛴 수 — 멱등 실행에서는 targeted와 같아진다 (기준 18) */
  skipped: number;
}

export interface ChunkTranslationJobOptions {
  /** 'demo' = DEMO_TRANSLATION_TARGETS만, 'all' = ACTIVE 전량 */
  scope: 'demo' | 'all';
  target: SupportedLang;
}

@Injectable()
export class ChunkTranslatorService {
  translatePending(_options: ChunkTranslationJobOptions): Promise<ChunkTranslationJobResult> {
    throw new Error('not implemented');
  }
}
