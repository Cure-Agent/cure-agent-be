/**
 * 블록 구간 배치 회귀 (issue #98) — 경계가 빠지거나 뒤섞인 판본에서 권고문 청크가
 * 블록 전체를 삼키지 않는지, 어떤 청크도 임베딩 상한을 넘지 않는지 고정한다.
 *
 * 실물 31건 실측에서 권고문+해설 671쌍 중 100쌍이 삼킴 상태였고, 그중 13건은
 * 임베딩 8192토큰 상한을 넘겨 문서째 적재에 실패했다.
 */
import {
  type GuidelineIngestInput,
  type IngestChunk,
} from '../../domain/guideline/service/guideline-ingest.input';
import {
  interleavedConsiderationPages,
  noConsiderationPages,
  oversizedBlockPages,
  trailingConsiderationPages,
} from '../../../test/fixtures/nckm-block-layout-samples';
import { chunkNckmGuideline, type GuidelineDocumentMeta } from './guideline-chunker';

const meta: GuidelineDocumentMeta = {
  title: '노을숲 증후군 한의표준임상진료지침',
  publisher: '가상한의연구원',
  version: '2026-08',
  publishedAt: '2026-08-01',
  sourceUrl: 'https://guidelines.example.test/sunset-forest',
};

/** §19 「청크 길이 상한」의 안전망 값. 어떤 청크도 이 길이를 넘지 않는다. */
const CHUNK_MAX_CHARS = 6000;

const allChunks = (input: GuidelineIngestInput): IngestChunk[] =>
  input.sections.flatMap((section) => section.chunks);

/** 등급이 붙은 청크가 권고문이다 (§20 계약) */
const recommendationOf = (input: GuidelineIngestInput): IngestChunk | undefined =>
  allChunks(input).find((chunk) => chunk.recommendationGrade !== undefined);

const explanationsOf = (input: GuidelineIngestInput): IngestChunk[] =>
  allChunks(input).filter((chunk) => chunk.recommendationGrade === undefined);

describe('issue #98: 블록 구간 배치가 다른 판본', () => {
  it('고려사항 제목이 없으면 권고문은 해설 시작 앞에서 끊긴다', () => {
    const { input } = chunkNckmGuideline(noConsiderationPages, meta);
    const recommendation = recommendationOf(input);

    expect(recommendation?.content).toBe(
      '안개숲 피로가 있는 성인에게 안개숲 뜸법을 적용할 것을 권고한다.',
    );
    // 해설·서지가 권고문으로 넘어오지 않는다
    expect(recommendation?.content).not.toContain('임상질문');
    expect(recommendation?.content).not.toContain('개별 연구 결과');
    expect(recommendation?.content).not.toContain('가상학회지');
    expect(explanationsOf(input).length).toBeGreaterThan(0);
  });

  it('고려사항이 해설 뒤에 와도 권고문이 해설을 삼키지 않는다', () => {
    const { input } = chunkNckmGuideline(trailingConsiderationPages, meta);
    const recommendation = recommendationOf(input);

    expect(recommendation?.content).toContain('물빛 침법을 적용할 것을 고려할 수 있다.');
    // 대괄호 표기도 고려사항 제목으로 인식해 권고문에 함께 담는다
    expect(recommendation?.content).toContain('자극 깊이');
    expect(recommendation?.content).not.toContain('(1) 배경');
    expect(recommendation?.content).not.toContain('가상 인구의 절반');
    // 해설은 해설 청크로 남는다
    expect(explanationsOf(input).map((chunk) => chunk.content).join('\n')).toContain(
      '가상 인구의 절반',
    );
  });

  it('고려사항이 해설 중간에 끼어도 해설 뒷조각이 사라지지 않는다', () => {
    const { input } = chunkNckmGuideline(interleavedConsiderationPages, meta);
    const recommendation = recommendationOf(input);
    const explanations = explanationsOf(input).map((chunk) => chunk.content).join('\n');

    expect(recommendation?.content).toContain('부항 시간');
    expect(recommendation?.content).not.toContain('근거 요약');
    // 고려사항 앞뒤로 갈라진 해설이 **둘 다** 살아난다
    expect(explanations).toContain('노을 부항은 가상의 결림 점수를 낮추는가?');
    expect(explanations).toContain('합성 연구 여덟 편에서');
  });

  it('참고문헌 표지가 있으면 그 뒤 서지를 어떤 청크에도 남기지 않는다', () => {
    const { input } = chunkNckmGuideline(trailingConsiderationPages, meta);
    const everything = allChunks(input).map((chunk) => chunk.content).join('\n');

    expect(everything).not.toContain('[참고문헌]');
    expect(everything).not.toContain('Invented Waterlight Needling Study');
  });

  it('구간 자체가 상한을 넘으면 분할하되 등급은 첫 조각에만 남긴다', () => {
    const { input, diagnostics } = chunkNckmGuideline(oversizedBlockPages, meta);
    const chunks = allChunks(input);

    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
    // 등급 있는 청크가 둘이 되면 §20 duplicated 진단이 재인용 오인으로 오작동한다
    expect(chunks.filter((chunk) => chunk.recommendationGrade !== undefined)).toHaveLength(1);
    expect(diagnostics.duplicated).toEqual([]);
    expect(diagnostics.missing).toEqual([]);
    expect(diagnostics.gradeMissing).toEqual([]);
  });
});
