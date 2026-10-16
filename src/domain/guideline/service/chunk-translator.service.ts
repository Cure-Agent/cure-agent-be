/**
 * 청크 번역 잡 (docs/specs/42).
 *
 * **번역이 없거나 stale한 ACTIVE 청크를 채우는 멱등 잡이다** — 최초 1회도, 신규 적재도, 개정도
 * 같은 코드가 처리한다. 개정이 들어오면 새 버전의 청크가 새 `content_hash`로 생기므로 자동으로
 * 미번역 상태가 되고 다음 실행이 주워간다. §26 개정 스케줄러에 훅을 걸 필요가 없다.
 *
 * 재적재(같은 판본의 새 revision)는 예외다 — 본문이 공백만 달라진 청크는 번역기를 부르지 않고
 * 이전 revision 청크의 번역을 옮겨 쓴다 (#535, `loadReusableTranslations`).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { TransactionManager } from '../../../global/database/transaction-manager';
import {
  SupportedLang,
  TRANSLATOR,
  Translator,
} from '../../../infrastructure/llm/translation/translator.port';
import {
  GuidelineRepository,
  ReusableChunkTranslation,
  TranslationReuseScope,
} from '../repository/guideline.repository';

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
  /** 이번 실행이 **본문까지** 새로 쓴 번역 행 수 */
  translated: number;
  /**
   * 번역기를 부르지 않고 **공백만 다른 청크의 기존 번역 본문을 옮겨 쓴** 행 수 (#535).
   *
   * `translated`와 나눠 세는 이유는 `pathFilled`와 같다 — 재적재 뒤 실행이 외부 호출 없이
   * 끝났는지를 출력 한 줄에서 구분할 수 있어야 한다.
   */
  reused: number;
  /**
   * 본문은 그대로 두고 **섹션 경로만** 채운 행 수 (#394).
   *
   * `translated`와 나눠 세는 이유는 관측이다 — 재실행이 싼 길로 갔는지(경로만) 비싼 길로
   * 갔는지(본문 재번역)를 출력 한 줄에서 구분할 수 없으면, 낭비가 조용히 누적된다.
   */
  pathFilled: number;
  /** 이미 최신 번역이 있어 건너뛴 수 — 멱등 실행에서는 targeted와 같아진다 (docs/specs/42 기준 18) */
  skipped: number;
}

export interface ChunkTranslationJobOptions {
  /** 'demo' = DEMO_TRANSLATION_TARGETS만, 'all' = ACTIVE 전량 */
  scope: 'demo' | 'all';
  target: SupportedLang;
}

/**
 * 섹션 경로를 원소별로 번역한다 (docs/specs/44 기준 9).
 *
 * **원문과 같은 길이의 배열을 낸다** — 원소 대응이 깨지면 헤더의 경로가 뒤섞여 다른 섹션을
 * 가리킨다. 한 원소라도 번역하지 못하면 배열 전체를 `null`로 두고 키 부재로 닫는다: 절반만
 * 영어인 경로는 원문보다 나쁘다.
 */
export async function translateSectionPath(
  path: readonly string[],
  translate: (segment: string) => Promise<string>,
): Promise<string[] | null> {
  const translated: string[] = [];
  for (const segment of path) {
    try {
      translated.push(await translate(segment));
    } catch {
      // 한 원소라도 못 옮기면 배열 전체를 버린다 — 부분 번역은 원문보다 나쁘다
      return null;
    }
  }
  return translated;
}

/**
 * 공백 제거 본문 (#535) — 번역 재사용 판정의 키다.
 *
 * #535 재적재의 파서 변경은 본문의 **공백만** 바꾼다(`이 상반응` 같은 띄어쓰기 오류). 공백만
 * 다른 두 본문은 같은 문장이고 번역도 같아야 한다 — 운영 실측에서 공백 오류가 든 청크 12건의
 * 번역이 모두 `Adverse reactions`로 바르게 옮겨져 있었다. 번역기는 깨진 띄어쓰기를 이미 읽어 냈다.
 *
 * JS 정규식 `\s`로 지운다. 같은 판정을 SQL에 맡기지 않는 이유는 저장소
 * `listReusableTranslations` 참고 — 축이 두 언어에 갈리면 같은 본문이 한쪽에서만 같다고 나온다.
 */
function stripWhitespace(text: string): string {
  return text.replace(/\s/g, '');
}

/**
 * 재사용 색인의 키 — 같은 지침·같은 판본·같은 공백 제거 본문.
 *
 * 구분자로 이어 붙이지 않고 배열을 직렬화한다 — 판본 문자열과 본문은 자유 텍스트라 어떤
 * 구분자 문자든 가질 수 있고, 그러면 서로 다른 세 값이 한 키로 붙는다.
 */
function reuseKey(guidelineId: string, version: string, content: string): string {
  return JSON.stringify([guidelineId, version, stripWhitespace(content)]);
}

/** 원문 섹션 경로가 원소 단위로 같은가 — 번역 경로를 그대로 옮겨도 되는 조건이다 */
function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
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
     *
     * **캐시를 DB에서 씨딩한다.** 실행 단위 캐시만 두면 재실행이 빈 Map으로 시작해 같은 제목을
     * 다시 번역하고, LLM이 다른 표기를 내 한 지침이 두 영문 제목으로 불린다(실측: 편두통이
     * 125건 대 5건으로 갈렸다). 개정 실행은 그 지침의 **일부 청크만** 건드리므로 같은 답변의
     * 인용 카드끼리 어긋난다 — 조용히 누적되는 종류라 씨딩으로 구조적으로 막는다.
     */
    const titleCache = await this.txManager.run(() =>
      this.repository.mapExistingTitleTranslations(options.target),
    );
    const translateTitle = async (title: string): Promise<string> => {
      // 후행 탭이 붙은 제목이 있으므로(기준 20) 번역기에는 정규화한 문자열을 넘긴다
      const key = title.replace(/^[\s\t\n\r]+|[\s\t\n\r]+$/g, '');
      const cached = titleCache.get(key);
      if (cached !== undefined) return cached;
      const value = await this.translator.translate(key, options.target);
      titleCache.set(key, value);
      return value;
    };

    // 섹션 경로도 제목과 같은 캐시를 쓴다 — 67섹션이 655청크에 반복되므로 원소마다 부르면
    // 같은 문자열을 열 번씩 번역한다(제목에서 실측된 것과 같은 낭비다)
    const translatePath = (path: readonly string[]): Promise<string[] | null> =>
      translateSectionPath(path, (segment) => translateTitle(segment));

    const reusable = await this.loadReusableTranslations(candidates, options.target);

    let translated = 0;
    let reused = 0;
    let pathFilled = 0;
    for (const candidate of candidates) {
      /**
       * 청크마다 순차로 부른다 — 배치라 지연이 사용자에게 보이지 않고, 동시 호출은 429를
       * 부른다(spec 31 프로브에서 워커 8이 rate limit 폭탄이었다). 한 건이 실패하면 잡 전체를
       * 세우지 않고 다음으로 넘어간다: 부분 성공이 저장돼 재실행이 나머지만 집어 든다.
       */
      try {
        if (candidate.bodyStale) {
          // 후보 자신은 원본이 될 수 없다 — 지금은 본문 stale인 후보의 행이 최신 번역 조회에
          // 걸리지 않아 저절로 빠지지만, 두 판정이 따로 바뀌어도 자기 행을 자기에게 되쓰지
          // 않도록 id로도 막는다
          const source = reusable
            .get(reuseKey(candidate.guidelineId, candidate.version, candidate.chunk.content))
            ?.find((row) => row.chunkId !== candidate.chunk.id);
          if (source) {
            /**
             * 공백만 다른 청크의 번역을 **옮겨 쓴다** — 번역기를 부르지 않는다 (#535).
             *
             * 재적재는 청크를 새 id로 다시 쓰고 번역 행은 `chunk_id`에 묶여 있어, 고치지 않으면
             * 새 revision의 청크가 전부 「번역 없음」이 되어 본문을 전량 재번역한다(데모 655청크
             * 기준 `gpt-5.4-mini`로 $3~8). 공백만 다른 본문의 번역은 그대로 유효하다.
             *
             * provenance는 둘로 갈린다. `translator_model`은 **원본 행의 것**이다 — 이 본문을
             * 실제로 만든 모델이고, 잡의 모델을 적으면 번역기를 부르지 않은 행이 그 모델의
             * 산출물로 기록된다. `source_content_hash`는 **후보의 것**이다 — 이 행이 대조되는
             * 원문은 후보 청크이고, 원본 해시를 적으면 다음 실행이 stale로 보고 또 쓴다.
             */
            const titleTranslated = await translateTitle(candidate.guidelineTitle);
            // 경로는 원문이 원소 단위로 같을 때만 옮긴다 — 재적재가 섹션 분할을 바꿨으면 같은
            // 본문이라도 다른 섹션에 있고, 옛 번역 경로는 다른 섹션을 가리킨다
            const sectionPathTranslated =
              source.sectionPathTranslated !== null &&
              samePath(source.sectionPath, candidate.sectionPath)
                ? source.sectionPathTranslated
                : await translatePath(candidate.sectionPath);
            await this.txManager.run(() =>
              this.repository.upsertChunkTranslation({
                id: ulid(),
                chunkId: candidate.chunk.id,
                lang: options.target,
                content: source.content,
                titleTranslated,
                sectionPathTranslated,
                sourceContentHash: candidate.chunk.contentHash,
                translatorModel: source.translatorModel,
              }),
            );
            reused += 1;
            continue;
          }

          const content = await this.translator.translate(candidate.chunk.content, options.target);
          const titleTranslated = await translateTitle(candidate.guidelineTitle);
          const sectionPathTranslated = await translatePath(candidate.sectionPath);
          await this.txManager.run(() =>
            this.repository.upsertChunkTranslation({
              id: ulid(),
              chunkId: candidate.chunk.id,
              lang: options.target,
              content,
              titleTranslated,
              sectionPathTranslated,
              sourceContentHash: candidate.chunk.contentHash,
              translatorModel: this.translator.model,
            }),
          );
          translated += 1;
          continue;
        }

        if (!candidate.pathMissing) continue;

        /**
         * 본문은 최신인데 경로만 비었다 — **경로만 부른다** (#394).
         *
         * 본문까지 재번역하면 ⑴ 청크 전문이 불필요하게 외부 호출을 타고 ⑵ 이미 저장된 영문
         * 본문이 새 생성물로 덮여 표현이 흔들리며 ⑶ 경로 번역이 계속 실패하는 청크가 **매
         * 실행마다** 본문을 다시 번역하는 고리에 갇힌다. 경로가 또 실패하면 `null`이 돌아와
         * 갱신을 건너뛰므로, 다음 실행도 여기(싼 쪽)로 다시 온다.
         */
        const sectionPathTranslated = await translatePath(candidate.sectionPath);
        if (!sectionPathTranslated) continue;
        await this.txManager.run(() =>
          this.repository.updateSectionPathTranslation(
            candidate.chunk.id,
            options.target,
            sectionPathTranslated,
          ),
        );
        pathFilled += 1;
      } catch (error) {
        this.logger.warn(`청크 ${candidate.chunk.id} 번역 실패 — 건너뜀: ${String(error)}`);
      }
    }

    return {
      targeted: candidates.length,
      translated,
      reused,
      pathFilled,
      skipped: candidates.length - translated - reused - pathFilled,
    };
  }

  /**
   * 본문을 새로 써야 하는 후보마다 재사용 원본 후보를 한 번에 읽어 색인한다 (#535).
   *
   * 원본은 후보와 **같은 지침·같은 판본 문자열** 안에서만 찾는다. 재적재가 만드는 짝은 언제나
   * 그 안에 있다(새 revision은 같은 판본에만 생긴다). 판본이 바뀐 개정은 지금처럼 새로
   * 번역한다 — 이 규칙이 없애려는 것은 같은 문서를 다시 파싱해 생긴 재번역뿐이고, 범위를
   * 넓히면 그 밖의 짝까지 실측 없이 묶인다. 범위를 후보가 속한 쌍으로 묶으므로, 실행
   * 범위(scope) 밖 지침의 청크에는 행이 생기지 않는다(그 청크는 애초에 후보가 아니다).
   *
   * 색인의 값은 `translated_at`이 늦은 순서다 — 저장소가 그 순서로 내므로 키마다 첫 행이
   * 가장 늦은 번역이다(기준 13).
   */
  private async loadReusableTranslations(
    candidates: readonly {
      guidelineId: string;
      version: string;
      bodyStale: boolean;
    }[],
    target: SupportedLang,
  ): Promise<Map<string, ReusableChunkTranslation[]>> {
    // 경로만 빈 후보·최신 후보는 본문을 쓰지 않으므로 원본이 필요 없다 — 멱등 재실행은 조회 0회다
    const scopes = new Map<string, TranslationReuseScope>();
    for (const candidate of candidates) {
      if (!candidate.bodyStale) continue;
      scopes.set(JSON.stringify([candidate.guidelineId, candidate.version]), {
        guidelineId: candidate.guidelineId,
        version: candidate.version,
      });
    }
    if (scopes.size === 0) return new Map();

    const rows = await this.txManager.run(() =>
      this.repository.listReusableTranslations(target, [...scopes.values()]),
    );
    const index = new Map<string, ReusableChunkTranslation[]>();
    for (const row of rows) {
      const key = reuseKey(row.guidelineId, row.version, row.chunkContent);
      const bucket = index.get(key);
      if (bucket) bucket.push(row);
      else index.set(key, [row]);
    }
    return index;
  }
}
