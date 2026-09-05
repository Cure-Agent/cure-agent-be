// docs/specs/45 수용 기준 1~28 동결 테스트 — 구현 중 수정 금지
import { GuidelineIngestInput } from '../../src/domain/guideline/service/guideline-ingest.input';

export const VOCAB_CORPUS_SIZE = 40;
export const COMMON_TERM = '빈번표식';
export const BOUNDARY_RARE_TERM = '희소별빛';
export const SINGLETON_RARE_TERM = '희소달빛';

/**
 * 기본 컷 0.05에서 흔함/희소함이 실제로 갈리는 합성 코퍼스다.
 *
 * - 빈번표식: 4/40 (컷 2 초과)
 * - 희소별빛: 2/40 (컷과 정확히 같음)
 * - 희소달빛: 1/40 (컷 미만)
 * - 임상: 두 청크에 걸쳐 세 어휘 항(임상적·임상연구·비임상시험)이 매칭되어
 *   항별 DF 합 3과 포스팅 합집합 2가 의도적으로 다르다.
 */
export const keywordVocabCorpus: GuidelineIngestInput = {
  title: '어휘 프리필터 합성 지침',
  publisher: '동결 테스트 발행처',
  version: '1.0',
  publishedAt: '2026-09-05',
  sourceUrl: 'https://example.test/spec45/vocab-corpus',
  sections: [
    {
      path: ['1', '합성 어휘'],
      title: '합성 어휘',
      order: 1,
      chunks: Array.from({ length: VOCAB_CORPUS_SIZE }, (_, index) => {
        const discriminatingTerms =
          index === 0
            ? `${BOUNDARY_RARE_TERM} 임상적 임상연구`
            : index === 1
              ? `${COMMON_TERM} ${BOUNDARY_RARE_TERM} 비임상시험`
              : index === 2
                ? `${COMMON_TERM} ${SINGLETON_RARE_TERM}`
                : index === 3 || index === 4
                  ? COMMON_TERM
                  : '배경어휘';

        return {
          content:
            `${discriminatingTerms} 합성근거${String(index).padStart(2, '0')} ` +
            `서로다른배경${String(index).padStart(2, '0')}`,
          recommendationNumber: `K${String(index + 1).padStart(2, '0')}`,
        };
      }),
    },
  ],
};

export interface SingleChunkGuidelineOptions {
  title?: string;
  publisher?: string;
  version?: string;
  publishedAt?: string;
  sourceUrl?: string;
}

/** 한 판본의 전용/공유 어절 및 관리자 갱신 시나리오용 최소 합성 지침. */
export function singleChunkGuideline(
  key: string,
  content: string,
  options: SingleChunkGuidelineOptions = {},
): GuidelineIngestInput {
  return {
    title: options.title ?? `${key} 합성 지침`,
    publisher: options.publisher ?? `${key} 합성 학회`,
    version: options.version ?? '1.0',
    publishedAt: options.publishedAt ?? '2026-09-05',
    sourceUrl: options.sourceUrl ?? `https://example.test/spec45/${key}`,
    sections: [
      {
        path: ['1', '합성 절'],
        title: '합성 절',
        order: 1,
        chunks: [{ content, recommendationNumber: 'R1' }],
      },
    ],
  };
}

export interface DirectChunkFixture {
  id: string;
  content: string;
}

/**
 * 원문 질의와 희소 토큰만 남긴 축약 질의의 순서가 반대가 되는 결정적 fixture.
 * rank-z는 원문 전체가 연속 일치하고, 축약 질의에서는 두 후보가 동점이라 id가 작은 rank-a가 앞선다.
 */
export const originalQueryRankingChunks: DirectChunkFixture[] = Array.from(
  { length: VOCAB_CORPUS_SIZE },
  (_, index) => {
    if (index === 0) {
      return { id: 'rank-a', content: `${BOUNDARY_RARE_TERM} 단독표현` };
    }
    if (index === 1) {
      return {
        id: 'rank-z',
        content: `${COMMON_TERM} ${BOUNDARY_RARE_TERM} 원문연속일치`,
      };
    }
    if (index === 2 || index === 3) {
      return {
        id: `rank-common-${String(index).padStart(2, '0')}`,
        content: `${COMMON_TERM} 흔한문맥${String(index).padStart(2, '0')}`,
      };
    }
    return {
      id: `rank-background-${String(index).padStart(2, '0')}`,
      content: `순위배경어휘${String(index).padStart(2, '0')}`,
    };
  },
);

/** word_similarity가 같은 두 후보에서 id 오름차순만이 순서를 가르는 fixture. */
export const tiedKeywordChunks: DirectChunkFixture[] = Array.from(
  { length: VOCAB_CORPUS_SIZE },
  (_, index) => {
    if (index === 0) return { id: 'tie-b', content: '동점희소 둘째배경' };
    if (index === 1) return { id: 'tie-a', content: '동점희소 첫째배경' };
    return {
      id: `tie-background-${String(index).padStart(2, '0')}`,
      content: `동점외부배경${String(index).padStart(2, '0')}`,
    };
  },
);
