/**
 * 청크 번역 잡 (docs/specs/42).
 *
 * **번역이 없거나 stale한 ACTIVE 청크를 채우는 멱등 잡이다** — 최초 1회도, 신규 적재도, 개정도
 * 같은 코드가 처리한다. 개정이 들어오면 새 버전의 청크가 새 `content_hash`로 생기므로 자동으로
 * 미번역 상태가 되고 다음 실행이 주워간다. §26 개정 스케줄러에 훅을 걸 필요가 없다.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { TransactionManager } from '../../../global/database/transaction-manager';
import {
  SupportedLang,
  TRANSLATOR,
  Translator,
} from '../../../infrastructure/llm/translation/translator.port';
import { GuidelineRepository } from '../repository/guideline.repository';

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
  private readonly logger = new Logger(ChunkTranslatorService.name);

  constructor(
    private readonly repository: GuidelineRepository,
    private readonly txManager: TransactionManager,
    @Inject(TRANSLATOR) private readonly translator: Translator,
  ) {}

  async translatePending(
    options: ChunkTranslationJobOptions,
  ): Promise<ChunkTranslationJobResult> {
    const prefixes = options.scope === 'demo' ? DEMO_TRANSLATION_TARGETS : null;
    const candidates = await this.txManager.run(() =>
      this.repository.listChunksNeedingTranslation(options.target, prefixes),
    );

    /**
     * 지침 제목 번역은 **지침 단위로 한 번만** 부른다.
     *
     * 제목은 같은 지침의 모든 청크에서 동일한데, 청크마다 번역하면 데모 6주제 기준 제목 6개를
     * 655번 번역하게 되어 호출·비용·시간이 두 배가 된다(실측: 655청크 → 1,310회). 번역 행에
     * 제목을 비정규화해 저장하는 것과 별개 축이다 — 저장은 조인을 줄이려는 것이고, 여기서
     * 줄이는 것은 **외부 호출**이다.
     *
     * 실패는 캐시하지 않는다 — 예외가 나면 항목이 비어 다음 청크가 다시 시도한다.
     */
    const titleCache = new Map<string, string>();
    const translateTitle = async (title: string): Promise<string> => {
      // 후행 탭이 붙은 제목이 있으므로(기준 20) 번역기에는 정규화한 문자열을 넘긴다
      const key = title.replace(/^[\s\t\n\r]+|[\s\t\n\r]+$/g, '');
      const cached = titleCache.get(key);
      if (cached !== undefined) return cached;
      const value = await this.translator.translate(key, options.target);
      titleCache.set(key, value);
      return value;
    };

    let translated = 0;
    for (const candidate of candidates) {
      if (!candidate.stale) continue;

      /**
       * 청크마다 순차로 부른다 — 배치라 지연이 사용자에게 보이지 않고, 동시 호출은 429를
       * 부른다(spec 31 프로브에서 워커 8이 rate limit 폭탄이었다). 한 건이 실패하면 잡 전체를
       * 세우지 않고 다음으로 넘어간다: 부분 성공이 저장돼 재실행이 나머지만 집어 든다.
       */
      try {
        const content = await this.translator.translate(candidate.chunk.content, options.target);
        const titleTranslated = await translateTitle(candidate.guidelineTitle);
        await this.txManager.run(() =>
          this.repository.upsertChunkTranslation({
            id: ulid(),
            chunkId: candidate.chunk.id,
            lang: options.target,
            content,
            titleTranslated,
            sourceContentHash: candidate.chunk.contentHash,
            translatorModel: this.translator.model,
          }),
        );
        translated += 1;
      } catch (error) {
        this.logger.warn(`청크 ${candidate.chunk.id} 번역 실패 — 건너뜀: ${String(error)}`);
      }
    }

    return {
      targeted: candidates.length,
      translated,
      skipped: candidates.length - translated,
    };
  }
}
