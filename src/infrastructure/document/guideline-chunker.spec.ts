// docs/specs/19 수용 기준 1~11 동결 테스트 — 구현 중 수정 금지
import { GuidelineIngestService } from '../../domain/guideline/service/guideline-ingest.service';
import {
  type GuidelineIngestInput,
  type IngestChunk,
} from '../../domain/guideline/service/guideline-ingest.input';
import { nckmSamplePages } from '../../../test/fixtures/nckm-pages.sample';
import {
  chunkNckmGuideline,
  type GuidelineDocumentMeta,
} from './guideline-chunker';

const meta: GuidelineDocumentMeta = {
  title: '달빛대사증 한의표준임상진료지침',
  publisher: '가상한의연구원',
  version: '2026-03',
  publishedAt: '2026-03-01',
  sourceUrl: 'https://guidelines.example.test/moonlight-metabolism',
};

interface LocatedChunk {
  sectionPath: string[];
  chunk: IngestChunk;
}

const flattenChunks = (input: GuidelineIngestInput): LocatedChunk[] =>
  input.sections.flatMap((section) =>
    section.chunks.map((chunk) => ({ sectionPath: section.path, chunk })),
  );

const findRecommendation = (
  chunks: LocatedChunk[],
  recommendationNumber: string,
): LocatedChunk | undefined =>
  chunks.find(
    ({ chunk }) =>
      chunk.recommendationNumber === recommendationNumber &&
      chunk.recommendationGrade !== undefined,
  );

const findExplanation = (
  chunks: LocatedChunk[],
  recommendationNumber: string,
): LocatedChunk | undefined =>
  chunks.find(
    ({ chunk }) =>
      chunk.recommendationNumber === recommendationNumber &&
      chunk.recommendationGrade === undefined &&
      chunk.evidenceLevel === undefined,
  );

describe('spec 19: 지침 PDF 파싱·청킹', () => {
  let parsed: GuidelineIngestInput;
  let chunks: LocatedChunk[];

  beforeEach(() => {
    parsed = chunkNckmGuideline(nckmSamplePages, meta).input;
    chunks = flattenChunks(parsed);
  });

  it('기준 1: 블록 수만큼 권고문 청크를 만들고 블록 마커의 권고 번호를 보존한다', () => {
    const recommendations = chunks.filter(
      ({ chunk }) => chunk.recommendationGrade !== undefined,
    );

    expect(recommendations).toHaveLength(4);
    expect(
      recommendations
        .map(({ chunk }) => chunk.recommendationNumber)
        .sort(),
    ).toEqual(['R1', 'R1-1', 'R2', 'R3']);
  });

  it('기준 2: 권고등급과 근거수준을 GRADE 메타데이터로 분리 매핑한다', () => {
    const r1 = findRecommendation(chunks, 'R1');
    const r2 = findRecommendation(chunks, 'R2');

    expect(r1?.chunk).toMatchObject({
      recommendationGrade: {
        system: 'GRADE',
        code: 'A',
        label: '강한 권고',
      },
      evidenceLevel: {
        system: 'GRADE',
        code: 'High',
        label: '높음',
      },
    });
    expect(r2?.chunk).toMatchObject({
      recommendationGrade: {
        system: 'GRADE',
        code: 'C',
        label: '약한 권고',
      },
      evidenceLevel: {
        system: 'GRADE',
        code: 'Very Low',
        label: '매우 낮음',
      },
    });
  });

  it('기준 3: GPP는 전문가 합의 권고로 기록하고 근거수준을 만들지 않는다', () => {
    const r3 = findRecommendation(chunks, 'R3');

    expect(r3?.chunk.recommendationGrade).toEqual({
      system: 'GRADE',
      code: 'GPP',
      label: '전문가 합의 권고',
    });
    expect(r3?.chunk.evidenceLevel).toBeUndefined();
  });

  it('기준 4: 권고문 content에는 권고 문장과 임상적 고려사항만 정제해 담는다', () => {
    const r1 = findRecommendation(chunks, 'R1');

    expect(r1?.chunk.content).toBe(
      [
        '성인은 별빛탕을 우선 사용할 것을 권고한다.',
        '임상적 고려사항',
        '열감이 심한 경우 용량을 조절한다.',
      ].join('\n'),
    );
  });

  it('기준 5: 한글 및 라틴 하이픈 하드 랩을 복원하고 문장 종결 줄은 경계로 남긴다', () => {
    const recommendation = findRecommendation(chunks, 'R1');
    const explanation = findExplanation(chunks, 'R1');

    expect(recommendation?.chunk.content).toContain(
      '성인은 별빛탕을 우선 사용할 것을 권고한다.\n임상적 고려사항',
    );
    expect(explanation?.chunk.content).toContain(
      'anti-obesity 프로그램은 허리둘레를 개선했다.',
    );
    expect(explanation?.chunk.content).not.toContain('anti-obe-\nsity');
  });

  it('기준 6: 해설 청크는 같은 권고 번호와 빈 등급을 가지며 하위번호는 임상질문부터 시작한다', () => {
    const r1Explanation = findExplanation(chunks, 'R1');
    const childExplanation = findExplanation(chunks, 'R1-1');

    expect(r1Explanation?.chunk).toMatchObject({
      recommendationNumber: 'R1',
      recommendationGrade: undefined,
      evidenceLevel: undefined,
    });
    expect(childExplanation?.chunk).toMatchObject({
      recommendationNumber: 'R1-1',
      recommendationGrade: undefined,
      evidenceLevel: undefined,
    });
    expect(childExplanation?.chunk.content).toMatch(/^\(1\) 임상질문: Q1-1/);
  });

  it('기준 7: 헤더 경로를 정규화·상속하고 1단계 절 변경 시 2단계 절을 초기화한다', () => {
    expect(findRecommendation(chunks, 'R1')?.sectionPath).toEqual([
      'Ⅳ. 권고사항',
      '1. 한의 단독 치료',
      '1) 별빛탕',
    ]);
    expect(findRecommendation(chunks, 'R2')?.sectionPath).toEqual([
      'Ⅳ. 권고사항',
      '1. 한의 단독 치료',
      '1) 별빛탕',
    ]);
    expect(findRecommendation(chunks, 'R3')?.sectionPath).toEqual([
      'Ⅳ. 권고사항',
      '1. 한의 단독 치료',
      '1) 별빛탕',
    ]);
    expect(findRecommendation(chunks, 'R1-1')?.sectionPath).toEqual([
      'Ⅳ. 권고사항',
      '2. 한의 복합 치료',
    ]);
  });

  it('기준 8: 청크 범위에는 물리 인덱스가 아닌 첫 줄의 인쇄 페이지 번호를 기록한다', () => {
    expect(findRecommendation(chunks, 'R1')?.chunk).toMatchObject({
      pageStart: 56,
      pageEnd: 56,
    });
    expect(findExplanation(chunks, 'R1')?.chunk).toMatchObject({
      pageStart: 56,
      pageEnd: 57,
    });
    expect(findRecommendation(chunks, 'R1-1')?.chunk).toMatchObject({
      pageStart: 59,
      pageEnd: 59,
    });
  });

  it('기준 9: Summary와 비숫자 페이지 및 제V장 텍스트를 모든 청크에서 제외한다', () => {
    const includedRecommendation = findRecommendation(chunks, 'R1');
    const allContent = chunks.map(({ chunk }) => chunk.content).join('\n');

    expect(includedRecommendation?.chunk.content).toContain(
      '성인은 별빛탕을 우선 사용할 것을 권고한다.',
    );
    expect(allContent).not.toContain('목차에만 있는 유령 권고 문구');
    expect(allContent).not.toContain('summary-only spectral advice');
    expect(allContent).not.toContain('후속 장의 안개 권고 문구');
    expect(allContent).not.toContain('R90');
    expect(allContent).not.toContain('R91');
    expect(allContent).not.toContain('R92');
  });

  it('기준 10: 참고문헌 표지 뒤의 서지 목록을 모든 청크에서 제외한다', () => {
    const explanation = findExplanation(chunks, 'R1');
    const allContent = chunks.map(({ chunk }) => chunk.content).join('\n');

    expect(explanation?.chunk.content).toContain(
      '가상 중재는 편안함을 높였다고 확인되었다.',
    );
    expect(allContent).not.toContain('[참고문헌]');
    expect(allContent).not.toContain('Moonlit Archive of Imaginary Metabolism');
    expect(allContent).not.toContain('A Catalogue of Starlight Decoctions');
    expect(allContent).not.toContain('Fictional Constitution Changes');
  });

  it('기준 11: 결과가 기존 GuidelineIngestService의 입력 검증을 통과한다', () => {
    const validator = Object.create(
      GuidelineIngestService.prototype,
    ) as GuidelineIngestService;
    const validate = (
      validator as unknown as {
        validate(input: GuidelineIngestInput): void;
      }
    ).validate.bind(validator);

    expect(() => validate(parsed)).not.toThrow();
  });
});

/**
 * docs/specs/19 「어절 경계 줄바꿈」 개정 (#535) — 줄 끝 공백 글리프로 어절 경계를 판정한다.
 *
 * 추출기가 공백 글리프를 지우지 않으므로(pdf-text.extractor) 페이지 텍스트의 줄 끝·줄 첫머리 공백이
 * 판정 근거다. 아래 fixture의 줄 끝 공백(`'…있는 '`)과 줄 안 연속 공백·탭은 의도한 것이다.
 */
describe('spec 19 개정(#535): 줄 끝 공백 글리프로 어절 경계를 판정한다', () => {
  const wordBoundaryPages: string[] = [
    [
      '56',
      'IV 권고사항',
      '1  한의 단독  치료',
      '1) 별빛탕',
      '【 R1 】',
      '권고안 권고등급/근거수준 참고문헌',
      '기저질환이 있는 ',
      '환자에게 별빛탕을 쓰고 식이 조절을 통해 ',
      '대사량을 늘릴 것을 권고한다. A/High 5-12)',
      '임상적 고려사항',
      '복용 중 이',
      '상반응이 나타나면\t\t용량을  줄인다.',
      '(1) 배경',
      '별빛탕의 효과는 두 차례 평가',
      '되었다.',
      'Visual Analogue',
      'Scale 점수는 anti-obe-',
      'sity 군에서 낮았다.',
      'moxi- ',
      'bustion 병행군은 meta ',
      '-analysis에서 우세했다.',
      '수축기 혈압은 감소하였으나1-3)',
      ' 이완기 혈압은 차이가 없었다.',
      '침 치료와 운동을 병행하고',
      ' ',
      '경과를 관찰했다.',
    ].join('\n'),
  ];

  let located: LocatedChunk[];

  beforeEach(() => {
    located = flattenChunks(chunkNckmGuideline(wordBoundaryPages, meta).input);
  });

  it('개정 a: 줄 끝 공백이 있는 한글 어절 경계는 공백으로 잇는다 — 격조사 끝과 비격조사 끝 모두', () => {
    expect(findRecommendation(located, 'R1')?.chunk.content).toMatch(
      /^기저질환이 있는 환자에게 별빛탕을 쓰고 식이 조절을 통해 대사량을 늘릴 것을 권고한다\.\n/,
    );
  });

  it('개정 b: 줄 끝 공백이 없는 어중 분리는 격조사 음절로 끝나도 붙인다', () => {
    const recommendation = findRecommendation(located, 'R1')?.chunk.content;
    const explanation = findExplanation(located, 'R1')?.chunk.content;

    expect(recommendation).toContain('복용 중 이상반응이 나타나면');
    expect(explanation).toContain('별빛탕의 효과는 두 차례 평가되었다.');
  });

  it('개정 c: 라틴 문자·숫자 규칙과 하이픈 규칙은 공백 글리프와 무관하게 그대로다', () => {
    const explanation = findExplanation(located, 'R1')?.chunk.content;

    expect(explanation).toContain('Visual Analogue Scale 점수는 anti-obesity 군에서 낮았다.');
    // 하이픈 뒤·앞에 글리프가 있어도 공백을 넣지 않는다 — `moxi- bustion`·`meta -analysis`가 되지 않는다
    expect(explanation).toContain('moxibustion 병행군은 meta-analysis에서 우세했다.');
  });

  it('개정 d: 줄 안의 연속 공백·탭은 한 칸이 된다 — 본문과 페이지 헤더 모두', () => {
    const recommendation = findRecommendation(located, 'R1');

    expect(recommendation?.chunk.content).toContain('나타나면 용량을 줄인다.');
    expect(recommendation?.sectionPath).toEqual(['Ⅳ. 권고사항', '1. 한의 단독 치료', '1) 별빛탕']);
  });

  it('개정 e: 공백 글리프가 다음 줄 첫머리에 붙어 와도 어절 경계로 본다 (위첨자 참고문헌 번호 뒤)', () => {
    expect(findExplanation(located, 'R1')?.chunk.content).toContain(
      '수축기 혈압은 감소하였으나1-3) 이완기 혈압은 차이가 없었다.',
    );
  });

  it('개정 f: 공백 글리프만 있는 줄은 버리되 위아래 줄 사이의 어절 경계로 본다', () => {
    expect(findExplanation(located, 'R1')?.chunk.content).toContain(
      '침 치료와 운동을 병행하고 경과를 관찰했다.',
    );
  });

  it('개정 전체: 권고문과 해설 청크가 위 규칙대로 정확히 이어진다', () => {
    expect(findRecommendation(located, 'R1')?.chunk.content).toBe(
      [
        '기저질환이 있는 환자에게 별빛탕을 쓰고 식이 조절을 통해 대사량을 늘릴 것을 권고한다.',
        '임상적 고려사항',
        '복용 중 이상반응이 나타나면 용량을 줄인다.',
      ].join('\n'),
    );
    expect(findExplanation(located, 'R1')?.chunk.content).toBe(
      [
        '(1) 배경',
        '별빛탕의 효과는 두 차례 평가되었다.',
        'Visual Analogue Scale 점수는 anti-obesity 군에서 낮았다.',
        'moxibustion 병행군은 meta-analysis에서 우세했다.',
        '수축기 혈압은 감소하였으나1-3) 이완기 혈압은 차이가 없었다.',
        '침 치료와 운동을 병행하고 경과를 관찰했다.',
      ].join('\n'),
    );
  });
});
