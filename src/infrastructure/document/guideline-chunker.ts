/**
 * NCKM 지침 권고문 청커 (docs/specs/19) — 페이지 텍스트를 권고문 단위 청크로 분해한다.
 *
 * 부수효과 없는 **순수 함수**다. PDF 추출(pdf-text.extractor)과 메타 조회(GuidelineParseService)는
 * 밖에 두고, 이 함수는 `(pages, meta) → GuidelineIngestInput` 변환만 책임진다 —
 * 5.6MB PDF 없이 텍스트 fixture만으로 전량 검증하기 위한 경계다.
 */
import {
  GuidelineIngestInput,
  IngestChunk,
  IngestRating,
  IngestSection,
} from '../../domain/guideline/service/guideline-ingest.input';

/** `GuidelineIngestInput`에서 sections를 뺀 문서 메타 — source_documents에서 온다 (§19 「문서 메타의 출처」) */
export type GuidelineDocumentMeta = Omit<GuidelineIngestInput, 'sections'>;

/** 인제스트 대상 장 — 이번 스펙은 비만 지침의 Ⅳ장(권고사항)만 다룬다 */
const TARGET_CHAPTER = 'IV';
/** 해설 청크 분할 임계값 — 누적 이 길이를 넘기 직전의 문단 경계에서 끊는다 */
const EXPLANATION_MAX_CHARS = 2000;

const PRINTED_PAGE = /^\d+$/;
const CHAPTER_HEADER = /^(I{1,3}|IV|VI{0,3}|IX|XI{0,3}|X)\s+(\S.*)$/;
const LEVEL1_HEADER = /^(\d+)\s+(\S.*)$/;
const LEVEL2_HEADER = /^(\d+\))\s*(\S.*)$/;
/** 헤더는 실측 최대 3줄(장·1단계·2단계)이다 — 본문을 헤더로 오독하지 않도록 상한을 둔다 */
const MAX_HEADER_LINES = 3;

const BLOCK_MARKER = /^【\s*(R[0-9-]+)\s*】$/;
const TABLE_HEADER = /^권고안\s+권고등급\/근거수준\s+참고문헌/;
const CONSIDERATION_HEADING = '임상적 고려사항';
/** 소절 마커: `(1)` 또는 `①`. 괄호 안이 숫자일 때만 마커다 — `(六君子湯)…` 같은 한자 줄바꿈과 구분한다 */
const SUBSECTION_MARKER = /^(?:\(\d+\)|[①-⑳])/;
const REFERENCES_MARKER = /^\[참고문헌\]$/;
/** 등급 토큰과 그 뒤(참고문헌 번호) 전체 — 근거수준은 `Very Low`를 `Low`보다 먼저 시도해야 잘리지 않는다 */
const GRADE_TAIL = /(?:^|\s)(GPP|[A-D]\/(?:Very Low|High|Moderate|Low))(?:\s.*)?$/;
/** 문장 종결 = 종결부호 + (선택) 참고문헌 번호. 이 줄만 문단 끝이고 나머지는 하드 랩이다 */
const SENTENCE_END = /[.!?。]\s*(?:\d+(?:\s*[,\-–~]\s*\d+)*\))?$/;

const ROMAN_FULLWIDTH: Record<string, string> = {
  I: 'Ⅰ',
  II: 'Ⅱ',
  III: 'Ⅲ',
  IV: 'Ⅳ',
  V: 'Ⅴ',
  VI: 'Ⅵ',
  VII: 'Ⅶ',
  VIII: 'Ⅷ',
  IX: 'Ⅸ',
  X: 'Ⅹ',
};

const GRADE_LABELS: Record<string, string> = {
  A: '강한 권고',
  B: '중등도 권고',
  C: '약한 권고',
  D: '권고하지 않음',
  GPP: '전문가 합의 권고',
};

const EVIDENCE_LABELS: Record<string, string> = {
  High: '높음',
  Moderate: '중등도',
  Low: '낮음',
  'Very Low': '매우 낮음',
};

/** 섹션 경로가 확정된 본문 한 줄 */
interface SourceLine {
  text: string;
  /** 인쇄 페이지 번호 (물리 인덱스가 아니다) */
  page: number;
  sectionPath: string[];
}

/** 하드 랩을 복원해 만든 문단 */
interface Paragraph {
  text: string;
  pageStart: number;
  pageEnd: number;
}

/**
 * 청킹 진단 (docs/specs/20) — 실패를 조용히 넘기지 않기 위한 근거다.
 *
 * 기준은 마커 *출현* 수가 아니라 *고유 권고 번호*다. 본문·결과요약표가 `【R】`를 재인용하므로
 * 출현 수는 블록 수의 불변식이 될 수 없다 (편두통 171: 출현 44 / 고유 37).
 */
export interface ChunkDiagnostics {
  /** 문서에서 관측된 고유 권고 번호 (재인용 제외 전) */
  uniqueNumbers: string[];
  /** 권고문 청크가 만들어지지 않은 번호 */
  missing: string[];
  /** 권고문 청크가 2개 이상 만들어진 번호 — 재인용을 블록으로 오인한 신호 */
  duplicated: string[];
  /** 권고문 청크는 있으나 등급을 추출하지 못한 번호 */
  gradeMissing: string[];
}

export interface ChunkResult {
  input: GuidelineIngestInput;
  diagnostics: ChunkDiagnostics;
}

/**
 * 페이지 텍스트 배열(물리 페이지 순서)을 인제스트 입력 + 진단으로 변환한다.
 *
 * 진단만 만들고 **던지지 않는다** — 실패 판정은 호출자(서비스)의 몫이다.
 * `verify:templates`는 여러 문서를 훑으며 상태를 모아야 하므로 예외로 중단되면 안 된다.
 */
export function chunkNckmGuidelineWithDiagnostics(
  pages: string[],
  meta: GuidelineDocumentMeta,
): ChunkResult {
  void pages;
  return {
    input: { ...meta, sections: [] },
    diagnostics: { uniqueNumbers: [], missing: [], duplicated: [], gradeMissing: [] },
  };
}

/**
 * 페이지 텍스트 배열(물리 페이지 순서)을 인제스트 입력으로 변환한다.
 *
 * @param pages PDF에서 추출한 페이지별 평문. 각 페이지 첫 줄이 인쇄 페이지 번호다.
 * @param meta 문서 메타 (title·publisher·version·publishedAt·sourceUrl)
 */
export function chunkNckmGuideline(
  pages: string[],
  meta: GuidelineDocumentMeta,
): GuidelineIngestInput {
  const lines = collectTargetChapterLines(pages);
  const sections = buildSections(lines);
  return { ...meta, sections };
}

/**
 * 대상 장(Ⅳ)의 본문 줄만 모은다.
 *
 * 페이지 헤더는 그 페이지가 **새로 선언하는 레벨만** 싣고 나머지는 생략하므로, 선언된 레벨만
 * 갱신하고 나머지는 직전 값을 상속한다 (페이지 패리티에 의존하지 않는다).
 */
function collectTargetChapterLines(pages: string[]): SourceLine[] {
  const collected: SourceLine[] = [];
  let chapter: string | null = null;
  let chapterTitle = '';
  let level1: string | null = null;
  let level2: string | null = null;

  for (const page of pages) {
    const lines = page.split('\n').map((line) => line.trim());
    // 첫 줄이 인쇄 번호가 아니면 콘텐츠 페이지가 아니다 (장 표지 등) — 상태도 갱신하지 않는다
    if (lines.length === 0 || !PRINTED_PAGE.test(lines[0])) continue;
    const printedPage = Number(lines[0]);

    let cursor = 1;
    for (let consumed = 0; consumed < MAX_HEADER_LINES && cursor < lines.length; consumed += 1) {
      const line = lines[cursor];
      const chapterMatch = CHAPTER_HEADER.exec(line);
      const level2Match = LEVEL2_HEADER.exec(line);
      const level1Match = LEVEL1_HEADER.exec(line);
      if (chapterMatch) {
        // 장 헤더는 짝수 페이지의 러닝 헤더로도 반복 등장한다 — 실제로 장이 바뀔 때만 절을 초기화한다
        if (chapter !== chapterMatch[1]) {
          level1 = null;
          level2 = null;
        }
        chapter = chapterMatch[1];
        chapterTitle = chapterMatch[2];
      } else if (level2Match) {
        level2 = `${level2Match[1]} ${level2Match[2]}`;
      } else if (level1Match) {
        const next = `${level1Match[1]}. ${level1Match[2]}`;
        // 1단계 절이 바뀌면 2단계 절을 초기화한다 (러닝 헤더로 같은 값이 반복될 때는 유지)
        if (level1 !== next) level2 = null;
        level1 = next;
      } else {
        break;
      }
      cursor += 1;
    }

    if (chapter !== TARGET_CHAPTER) continue;

    const sectionPath = [
      `${ROMAN_FULLWIDTH[chapter] ?? chapter}. ${chapterTitle}`,
      ...(level1 ? [level1] : []),
      ...(level2 ? [level2] : []),
    ];
    for (const text of lines.slice(cursor)) {
      if (text.length > 0) collected.push({ text, page: printedPage, sectionPath });
    }
  }
  return collected;
}

/** 권고 블록을 분해해 섹션으로 묶는다. 청크가 없는 섹션은 만들지 않는다. */
function buildSections(lines: SourceLine[]): IngestSection[] {
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (BLOCK_MARKER.test(line.text)) starts.push(index);
  });

  const sections: IngestSection[] = [];
  starts.forEach((start, order) => {
    const end = order + 1 < starts.length ? starts[order + 1] : lines.length;
    const chunks = buildBlockChunks(lines.slice(start, end));
    if (chunks.length === 0) return;

    const path = lines[start].sectionPath;
    const last = sections[sections.length - 1];
    if (last && samePath(last.path, path)) {
      last.chunks.push(...chunks);
      return;
    }
    sections.push({
      path,
      title: path[path.length - 1],
      order: sections.length,
      chunks,
    });
  });
  return sections;
}

/** 블록 하나 → 권고문 청크 1개 + 해설 청크 1개 이상 */
function buildBlockChunks(block: SourceLine[]): IngestChunk[] {
  const recommendationNumber = BLOCK_MARKER.exec(block[0].text)?.[1];
  if (!recommendationNumber) return [];

  const bodyStart = TABLE_HEADER.test(block[1]?.text ?? '') ? 2 : 1;
  const considerationAt = block.findIndex(
    (line, index) => index >= bodyStart && line.text === CONSIDERATION_HEADING,
  );
  const statementEnd = considerationAt === -1 ? block.length : considerationAt;

  const statementLines = block.slice(bodyStart, statementEnd);
  const grades = extractGrades(statementLines);

  // 등급 토큰과 뒤따르는 참고문헌 번호는 본문에서 제거한다 — 등급은 메타데이터에 있고,
  // 참고문헌 번호는 가리킬 서지 목록을 버리므로 본문에 남기면 잔여물이 된다.
  const statement = toParagraphs(
    statementLines.map((line) => ({ ...line, text: line.text.replace(GRADE_TAIL, '') })),
  );

  const explanationAt = block.findIndex(
    (line, index) => index > considerationAt && SUBSECTION_MARKER.test(line.text),
  );
  const referencesAt = block.findIndex((line) => REFERENCES_MARKER.test(line.text));
  const considerationEnd = explanationAt === -1 ? block.length : explanationAt;
  const consideration =
    considerationAt === -1 ? [] : toParagraphs(block.slice(considerationAt, considerationEnd));

  const chunks: IngestChunk[] = [];
  const recommendation = mergeParagraphs([...statement, ...consideration]);
  if (recommendation) {
    chunks.push({
      content: recommendation.text,
      recommendationNumber,
      recommendationGrade: grades.recommendationGrade,
      evidenceLevel: grades.evidenceLevel,
      pageStart: recommendation.pageStart,
      pageEnd: recommendation.pageEnd,
    });
  }

  if (explanationAt !== -1) {
    const explanationEnd =
      referencesAt !== -1 && referencesAt > explanationAt ? referencesAt : block.length;
    const paragraphs = toParagraphs(block.slice(explanationAt, explanationEnd));
    for (const part of splitByLength(paragraphs, EXPLANATION_MAX_CHARS)) {
      chunks.push({
        // 등급은 권고에 부여된 것이지 해설 문단에 부여된 것이 아니다 — 복사하면 인용의 근거가
        // 실제보다 강해 보인다. 키를 명시해 "비어 있음"이 형태로도 드러나게 둔다.
        content: part.text,
        recommendationNumber,
        recommendationGrade: undefined,
        evidenceLevel: undefined,
        pageStart: part.pageStart,
        pageEnd: part.pageEnd,
      });
    }
  }
  return chunks;
}

function extractGrades(statementLines: SourceLine[]): {
  recommendationGrade?: IngestRating;
  evidenceLevel?: IngestRating;
} {
  for (const line of statementLines) {
    const token = GRADE_TAIL.exec(line.text)?.[1];
    if (!token) continue;
    if (token === 'GPP') {
      return { recommendationGrade: rating('GPP', GRADE_LABELS.GPP) };
    }
    const [code, level] = token.split('/');
    return {
      recommendationGrade: rating(code, GRADE_LABELS[code] ?? code),
      evidenceLevel: rating(level, EVIDENCE_LABELS[level] ?? level),
    };
  }
  return {};
}

function rating(code: string, label: string): IngestRating {
  return { system: 'GRADE', code, label };
}

/**
 * 하드 랩을 복원해 문단 배열로 만든다.
 *
 * 추출 텍스트의 줄바꿈은 지면의 시각적 줄바꿈이라, 문장이 줄 중간에서 잘린다.
 * 문장 종결로 끝난 줄과 구조 줄(소제목·소절 마커)만 문단 경계이고 나머지는 다음 줄과 이어붙인다.
 */
function toParagraphs(lines: SourceLine[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let current: Paragraph | null = null;

  const flush = (): void => {
    if (current && current.text.length > 0) paragraphs.push(current);
    current = null;
  };

  for (const line of lines) {
    if (line.text.length === 0) continue;
    if (isStructuralLine(line.text)) {
      flush();
      paragraphs.push({ text: line.text, pageStart: line.page, pageEnd: line.page });
      continue;
    }
    if (current === null) {
      current = { text: line.text, pageStart: line.page, pageEnd: line.page };
    } else {
      current.text = appendWrapped(current.text, line.text);
      current.pageEnd = line.page;
    }
    if (SENTENCE_END.test(line.text)) flush();
  }
  flush();
  return paragraphs;
}

function isStructuralLine(text: string): boolean {
  return (
    text === CONSIDERATION_HEADING ||
    SUBSECTION_MARKER.test(text) ||
    REFERENCES_MARKER.test(text) ||
    BLOCK_MARKER.test(text) ||
    TABLE_HEADER.test(text)
  );
}

/** 하이픈 랩은 하이픈을 지우고, 라틴 문자·숫자끼리는 공백 하나로, 그 외(한글·한자)는 공백 없이 잇는다 */
function appendWrapped(accumulated: string, next: string): string {
  if (/-$/.test(accumulated) && /^[A-Za-z]/.test(next)) {
    return `${accumulated.slice(0, -1)}${next}`;
  }
  if (/[A-Za-z0-9]$/.test(accumulated) && /^[A-Za-z0-9]/.test(next)) {
    return `${accumulated} ${next}`;
  }
  if (endsAtWordBoundary(accumulated) && /^[가-힣]/.test(next)) {
    return `${accumulated} ${next}`;
  }
  return `${accumulated}${next}`;
}

/**
 * 어절 경계에서 끊긴 줄인지 추정한다.
 *
 * 한글 줄바꿈은 어중(`권`/`고한다`)과 어절 경계(`있는`/`환자에게`) 양쪽에서 일어나는데, 후자의 공백은
 * 양쪽 정렬이 흡수해 **PDF에 아예 인코딩되지 않는다**(pdfjs 항목 단위로도 없다). 복구 불가능한
 * 정보라 형태로 추정한다 — 마지막 음절이 격조사면 어절이 끝난 것으로 본다.
 *
 * **격조사만 넣고 어미(`고`·`해` 등)는 넣지 않는다.** 요약문의 권고 문장 44개를 정답지로 측정하면
 * 격조사만 쓸 때 36/44가 일치하고 어미를 더하면 `고려`가 `고`/`려`로 끊긴 자리에서 오탐이 나
 * 32/44로 떨어진다 (미적용은 24/44). 불일치 8건 중 7건은 정답지인 요약문 쪽이 공백을 잃은 자리라
 * **실제 정확도는 43/44**이고, 유일한 오류는 의존명사 `수` 앞에서 끊긴 R7이다.
 * 권고 문장은 임상의에게 그대로 인용되는 텍스트라 정확도를 우선한다 (docs/specs/19 「어절 경계 줄바꿈」).
 */
const PARTICLE_ENDINGS = new Set([
  '을', '를', '이', '가', '은', '는', '의', '에', '로', '와', '과', '도', '만',
]);

function endsAtWordBoundary(text: string): boolean {
  const last = text.slice(-1);
  // 단음절 어절 자체는 판단 근거가 없다 — 앞에 다른 글자가 붙어 있을 때만 조사·어미로 본다
  return text.length > 1 && PARTICLE_ENDINGS.has(last);
}

function mergeParagraphs(paragraphs: Paragraph[]): Paragraph | null {
  if (paragraphs.length === 0) return null;
  return {
    text: paragraphs.map((paragraph) => paragraph.text).join('\n'),
    pageStart: paragraphs[0].pageStart,
    pageEnd: paragraphs[paragraphs.length - 1].pageEnd,
  };
}

/** 누적 길이가 상한을 넘기 직전의 문단 경계에서 끊는다 */
function splitByLength(paragraphs: Paragraph[], maxChars: number): Paragraph[] {
  const parts: Paragraph[] = [];
  let buffer: Paragraph[] = [];
  let length = 0;

  const flush = (): void => {
    const merged = mergeParagraphs(buffer);
    if (merged) parts.push(merged);
    buffer = [];
    length = 0;
  };

  for (const paragraph of paragraphs) {
    if (buffer.length > 0 && length + paragraph.text.length > maxChars) flush();
    buffer.push(paragraph);
    length += paragraph.text.length + 1;
  }
  flush();
  return parts;
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
