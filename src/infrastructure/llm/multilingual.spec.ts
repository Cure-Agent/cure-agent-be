// docs/specs/42 BE 수용 기준 4·8·13·21·24 동결 테스트 — 구현 중 수정 금지
import { getTableColumns } from 'drizzle-orm';
import { toCitationDto } from '../../domain/conversation/mapper/conversation.mapper';
import { toEvidenceDetail } from '../../domain/guideline/mapper/guideline.mapper';
import { evidenceChunkTranslations } from '../../domain/guideline/persistence/guideline.schema';
import { type LlmStreamRequest } from './llm-provider.port';
import { buildPrompt, PROMPT_VERSION } from './prompt-builder';
import { detectQueryLanguage } from './query-language';

const ORIGINAL_HASH = 'sha256-original-content';
const CHANGED_HASH = 'sha256-revised-content';
const LONG_TRANSLATION = Array.from(
  { length: 270 },
  (_, index) => String.fromCharCode(65 + (index % 26)),
).join('');
const EXPECTED_QUOTE_TRANSLATED = `${LONG_TRANSLATION.slice(0, 240)}…`;

const BASE_REQUEST: LlmStreamRequest = {
  question: 'What does the guideline recommend?',
  evidence: [
    {
      marker: 1,
      content: '합성 지침 근거 본문',
      guidelineTitle: '합성 진료지침',
      sectionPath: ['치료', '권고'],
    },
  ],
};

type ResponseLangRequest = LlmStreamRequest & { responseLang: 'ko' | 'en' };

function promptFor(responseLang: 'ko' | 'en') {
  return buildPrompt({
    ...BASE_REQUEST,
    responseLang,
  } as ResponseLangRequest);
}

function translationRow(sourceContentHash = ORIGINAL_HASH) {
  const now = new Date('2026-08-29T00:00:00.000Z');
  return {
    id: 'translation-unit-en',
    chunkId: 'chunk-unit',
    lang: 'en',
    content: LONG_TRANSLATION,
    sourceContentHash,
    translatorModel: 'unit-translator-v1',
    translatedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 구현이 row에 응답 언어를 싣든 mapper의 두 번째 인자로 넘기든 같은 계약을 단언한다.
 * 현재 mapper는 두 번째 인자를 무시하므로 번역 필드 양성 단언에서 반드시 실패한다.
 */
function mapCitation(
  sourceContentHash = ORIGINAL_HASH,
  responseLang: 'ko' | 'en' = 'en',
) {
  const now = new Date('2026-08-29T00:00:00.000Z');
  const translation = translationRow(sourceContentHash);
  const row = {
    citation: {
      id: 'citation-unit',
      messageId: 'message-unit',
      evidenceChunkId: 'chunk-unit',
      marker: 1,
      quote: '한국어 인용 원문',
      createdAt: now,
      updatedAt: now,
    },
    guideline: {
      id: 'guideline-unit',
      title: '합성 진료지침',
      publisher: '합성 발행처',
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    },
    version: {
      id: 'version-unit',
      guidelineId: 'guideline-unit',
      version: '1.0',
      revision: 1,
      status: 'ACTIVE',
      publishedAt: now,
      sourceUrl: 'https://example.test/guideline',
      contentHash: 'version-hash',
      createdAt: now,
      updatedAt: now,
    },
    section: {
      id: 'section-unit',
      guidelineVersionId: 'version-unit',
      title: '권고',
      path: ['치료', '권고'],
      order: 1,
      createdAt: now,
      updatedAt: now,
    },
    chunk: {
      id: 'chunk-unit',
      sectionId: 'section-unit',
      guidelineVersionId: 'version-unit',
      content: '한국어 청크 원문',
      embedding: [],
      embeddingModel: 'fake-embedding-v1',
      recommendationNumber: null,
      recommendationGrade: null,
      evidenceLevel: null,
      pageStart: null,
      pageEnd: null,
      order: 1,
      contentHash: ORIGINAL_HASH,
      createdAt: now,
      updatedAt: now,
    },
    translation,
    chunkTranslation: translation,
    responseLang,
  };

  const mapper = toCitationDto as unknown as (
    value: unknown,
    lang?: 'ko' | 'en',
  ) => ReturnType<typeof toCitationDto>;
  return mapper(row, responseLang);
}

function mapEvidence(
  chunkContentHash: string,
  responseLang: 'ko' | 'en' = 'en',
) {
  const now = new Date('2026-08-29T00:00:00.000Z');
  const translation = translationRow(ORIGINAL_HASH);
  const row = {
    chunk: {
      id: 'chunk-unit',
      sectionId: 'section-unit',
      guidelineVersionId: 'version-unit',
      content: '한국어 청크 원문',
      embedding: [],
      embeddingModel: 'fake-embedding-v1',
      recommendationNumber: null,
      recommendationGrade: null,
      evidenceLevel: null,
      pageStart: null,
      pageEnd: null,
      order: 1,
      contentHash: chunkContentHash,
      createdAt: now,
      updatedAt: now,
    },
    section: {
      id: 'section-unit',
      guidelineVersionId: 'version-unit',
      title: '권고',
      path: ['치료', '권고'],
      order: 1,
      createdAt: now,
      updatedAt: now,
    },
    version: {
      id: 'version-unit',
      guidelineId: 'guideline-unit',
      version: '1.0',
      revision: 1,
      status: 'ACTIVE',
      publishedAt: now,
      sourceUrl: 'https://example.test/guideline',
      contentHash: 'version-hash',
      createdAt: now,
      updatedAt: now,
    },
    guideline: {
      id: 'guideline-unit',
      title: '합성 진료지침',
      publisher: '합성 발행처',
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    },
    translation,
    chunkTranslation: translation,
    responseLang,
  };

  const mapper = toEvidenceDetail as unknown as (
    value: unknown,
    lang?: 'ko' | 'en',
  ) => ReturnType<typeof toEvidenceDetail>;
  return mapper(row, responseLang);
}

describe('spec 42: 다국어 프롬프트·번역 파생물 단위 계약', () => {
  it('[기준 4] 한국어 경로의 promptVersion은 qa-v6 그대로다', () => {
    const koreanPrompt = promptFor('ko');
    const englishControl = promptFor('en');

    expect(PROMPT_VERSION).toBe('qa-v6');
    expect(koreanPrompt.system).toContain('한국어로 간결하게 답한다.');
    // 영문 양성 대조가 있어, 언어 분기가 없는 현재 프롬프트가 공허하게 통과하지 않는다.
    expect(englishControl.system).toMatch(/영어|English/i);
  });

  it('[기준 8] responseLang=en이면 생성 프롬프트의 언어 규칙이 영어를 지시한다', () => {
    const prompt = promptFor('en');

    expect(prompt.system).toMatch(/영어|English/i);
    expect(prompt.system).not.toContain('한국어로 간결하게 답한다.');
  });

  it('[기준 13] quoteTranslated는 240자를 넘는 청크 번역을 240자로 자르고 말줄임표를 붙인다', () => {
    const citation = mapCitation();

    expect(LONG_TRANSLATION.length).toBeGreaterThan(240);
    expect(citation.quoteTranslated).toBe(EXPECTED_QUOTE_TRANSLATED);
    expect(citation.quoteTranslated).toHaveLength(241);
  });

  it('[기준 21] 원문 content_hash가 바뀌면 기존 번역은 stale로 판정된다', () => {
    const fresh = mapEvidence(ORIGINAL_HASH);
    const stale = mapEvidence(CHANGED_HASH);

    // stale 키 부재만 단언하면 현재 mapper도 우연히 통과하므로 fresh 양성 대조를 함께 둔다.
    expect(fresh.excerptTranslated).toBe(LONG_TRANSLATION);
    expect(fresh.translationModel).toBe('unit-translator-v1');
    expect(stale).not.toHaveProperty('excerptTranslated');
    expect(stale).not.toHaveProperty('translationModel');
  });

  it('[기준 24] evidence_chunk_translations 스키마에는 임베딩 벡터 컬럼이 없다', () => {
    const columns = getTableColumns(evidenceChunkTranslations);
    const columnNames = Object.keys(columns);
    const sqlTypes = Object.values(columns).map((column) =>
      column.getSQLType().toLowerCase(),
    );

    expect(columnNames).not.toEqual(
      expect.arrayContaining(['embedding', 'embeddingModel']),
    );
    expect(sqlTypes.some((sqlType) => sqlType.includes('vector'))).toBe(false);

    // 이 스키마 조각은 이미 스텁에 있으므로, 다국어 기능의 양성 대조도 끝까지 도달해야 한다.
    expect(detectQueryLanguage('What treatment is recommended?')).toBe('en');
  });
});
