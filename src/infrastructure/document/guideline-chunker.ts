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
/** 해설 청크 분할 임계값 — 누적 이 길이를 넘기 직전의 문단 경계에서 끊는다 */
const EXPLANATION_MAX_CHARS = 2000;
/** 마커 뒤 이 줄 수 안에 표 헤더나 등급이 오면 권고 블록이다 — 재인용과 구분한다 (docs/specs/20) */
const BLOCK_EVIDENCE_WINDOW = 10;

/**
 * 인쇄 번호. 러닝 타이틀이 붙어 오는 판본이 있다 (`54견비통 한의표준임상진료지침`).
 * 3자리로 제한하고 뒤를 비숫자로 강제해 `2016년 …` 같은 본문 줄을 배제한다.
 */
const PRINTED_PAGE = /^(\d{1,3})(?:[^\d\s].*)?$/;
/** 장 헤더 — ASCII `IV 권고사항`과 전각+마침표 `Ⅳ. 권고사항`을 모두 받는다 */
const CHAPTER_HEADER = /^([IVX]{1,4}|[Ⅰ-Ⅻ])\.?\s+(\S.*)$/;
/** 절 헤더 — `1 한약` `1. 한약`(1단계) / `1) 한약`(2단계) / `● ■ ▣ ◆ □ ▶`(기호) */
const NUMBERED_LEVEL2 = /^(\d+\))\s*(\S.*)$/;
const NUMBERED_LEVEL1 = /^(\d+)\.?\s+(\S.*)$/;
const SYMBOL_HEADER = /^([●■▣◆□▶])\s*(\S.*)$/;
/** 헤더는 실측 최대 3줄(장·1단계·2단계)이다 — 본문을 헤더로 오독하지 않도록 상한을 둔다 */
const MAX_HEADER_LINES = 3;
/**
 * 헤더 줄 길이 상한. 절 헤더가 `1. 한의복합치료`처럼 마침표 형태로도 오므로, 길이 제한이 없으면
 * 참고문헌 항목(`15. 송미영, 박지훈, … 피하지방 감량에 있어 …`)이 1단계 절로 오인된다.
 * 실측 헤더는 최장 20자 남짓이고 서지 항목은 40자를 훌쩍 넘는다.
 */
const MAX_HEADER_LENGTH = 40;

/** 마커 뒤에 제목이 붙는 판본이 있다 (`【R1】 삶의 질 개선`) — 번호만 취하고 제목은 버린다 */
const BLOCK_MARKER = /^【\s*(R[0-9-]+)\s*】\s*(.*)$/;
/** 표 헤더 — 컬럼 구성이 판본마다 다르다 (`권고안 번호 권고내용 권고등급/근거수준`) */
const TABLE_HEADER = /^권고안(\s+번호)?\s+(권고내용\s+)?권고등급\s*\/\s*근거수준/;
const CONSIDERATION_HEADING = '임상적 고려사항';
/** 소절 마커: `(1)` 또는 `①`. 괄호 안이 숫자일 때만 마커다 — `(六君子湯)…` 같은 한자 줄바꿈과 구분한다 */
const SUBSECTION_MARKER = /^(?:\(\d+\)|[①-⑳])/;
const REFERENCES_MARKER = /^\[참고문헌\]$/;
/**
 * 등급 토큰. 판본마다 표기가 흔들린다 — 슬래시 둘레 공백(`A / Moderate`),
 * 대소문자(`B / Very low`·`B/MODERATE`). 대소문자 무시로 받고 코드는 정규형으로 모은다
 * (`MODERATE`와 `Moderate`가 서로 다른 코드가 되면 등급으로 거를 수 없다).
 * 근거수준은 `Very Low`를 `Low`보다 먼저 시도해야 잘리지 않는다.
 */
const EVIDENCE_LEVEL_PATTERN = '(?:Very\\s+Low|High|Moderate|Low|CTB)';
/** `GPP`는 근거수준 없이 오기도 하고 `GPP/CTB`처럼 붙어 오기도 한다. `A`~`D`는 항상 근거수준을 동반한다 */
const GRADE_PATTERN =
  `(GPP(?:\\s*/\\s*${EVIDENCE_LEVEL_PATTERN})?|[A-D]\\s*/\\s*${EVIDENCE_LEVEL_PATTERN})`;
const GRADE_TOKEN = new RegExp(`(?:^|\\s)${GRADE_PATTERN}(?=\\s|$)`, 'i');
const GRADE_TAIL = new RegExp(`(?:^|\\s)${GRADE_PATTERN}(?:\\s.*)?$`, 'i');

/** 원문 표기의 대소문자 흔들림을 정규형으로 모은다 */
const EVIDENCE_CANONICAL: Record<string, string> = {
  'very low': 'Very Low',
  high: 'High',
  moderate: 'Moderate',
  low: 'Low',
  ctb: 'CTB',
};
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
  // 지침이 직접 정의한다 — "현대적 연구방법론을 활용한 근거연구가 아직 수행되지 않았으나,
  // 기성 한의서 등 고전 텍스트에 근거가 있는 경우 CTB (Classical Text-based)를 부여"
  CTB: '고전문헌 근거',
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
 *
 * @param pages PDF에서 추출한 페이지별 평문. 각 페이지 첫 줄이 인쇄 페이지 번호다.
 * @param meta 문서 메타 (title·publisher·version·publishedAt·sourceUrl)
 */
export function chunkNckmGuideline(
  pages: string[],
  meta: GuidelineDocumentMeta,
): ChunkResult {
  const lines = collectTargetChapterLines(pages);
  const occurrences = findMarkerOccurrences(lines);
  const blockStarts = occurrences.filter((o) => isBlockStart(lines, o.index));
  const sections = buildSections(lines, blockStarts);

  const chunks = sections.flatMap((section) => section.chunks);
  const recommendationCounts = new Map<string, number>();
  const graded = new Set<string>();
  for (const chunk of chunks) {
    const number = chunk.recommendationNumber;
    if (number === undefined) continue;
    if (chunk.recommendationGrade) {
      graded.add(number);
      recommendationCounts.set(number, (recommendationCounts.get(number) ?? 0) + 1);
    } else if (!recommendationCounts.has(number)) {
      // 등급 추출에 실패해도 그 번호의 첫 청크는 권고문이다 (해설은 언제나 뒤따른다)
      recommendationCounts.set(number, 1);
    }
  }

  const uniqueNumbers = [...new Set(occurrences.map((o) => o.number))];
  const produced = new Set(blockStarts.map((o) => o.number));
  return {
    input: { ...meta, sections },
    diagnostics: {
      uniqueNumbers,
      missing: uniqueNumbers.filter((n) => !produced.has(n)),
      duplicated: [...recommendationCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([number]) => number),
      gradeMissing: [...produced].filter((n) => !graded.has(n)),
    },
  };
}

interface MarkerOccurrence {
  index: number;
  number: string;
}

function findMarkerOccurrences(lines: SourceLine[]): MarkerOccurrence[] {
  const occurrences: MarkerOccurrence[] = [];
  lines.forEach((line, index) => {
    const number = BLOCK_MARKER.exec(line.text)?.[1];
    if (number) occurrences.push({ index, number });
  });
  return occurrences;
}

/**
 * 마커 출현이 권고 블록인지 판정한다 (docs/specs/20 「마커 재인용과 블록 판정」).
 *
 * 본문·결과요약표가 `【R】`를 다시 인용하므로 출현 수는 블록 수가 아니다(편두통: 출현 44 / 고유 37).
 * 실제 블록은 뒤에 표 헤더나 등급이 따라오고, 재인용은 둘 다 없다.
 */
function isBlockStart(lines: SourceLine[], index: number): boolean {
  const window = lines.slice(index + 1, index + 1 + BLOCK_EVIDENCE_WINDOW);
  return window.some((line) => TABLE_HEADER.test(line.text) || GRADE_TOKEN.test(line.text));
}

/** 페이지 헤더를 파싱한 결과 — 선언되지 않은 항목은 undefined다 */
interface PageHeader {
  printedPage: number;
  chapter?: { numeral: string; title: string };
  /** 0 = 1단계 절, 1 = 2단계 절 */
  levels: (string | undefined)[];
  /** 본문이 시작하는 줄 인덱스 */
  bodyStart: number;
}

function parsePageHeader(lines: string[]): PageHeader | null {
  const printed = PRINTED_PAGE.exec(lines[0] ?? '');
  // 첫 줄이 인쇄 번호가 아니면 콘텐츠 페이지가 아니다 (장 표지 등)
  if (!printed) return null;

  const header: PageHeader = { printedPage: Number(printed[1]), levels: [], bodyStart: 1 };
  // 번호 있는 절은 형태가 레벨을 정하고, 기호 절은 그 페이지에서 남은 다음 레벨을 차지한다
  let nextSymbolLevel = 0;
  for (let consumed = 0; consumed < MAX_HEADER_LINES && header.bodyStart < lines.length; ) {
    const line = lines[header.bodyStart];
    if (line.length > MAX_HEADER_LENGTH) break;
    const chapterMatch = CHAPTER_HEADER.exec(line);
    const level2Match = NUMBERED_LEVEL2.exec(line);
    const level1Match = NUMBERED_LEVEL1.exec(line);
    const symbolMatch = SYMBOL_HEADER.exec(line);

    if (chapterMatch) {
      header.chapter = { numeral: normalizeRoman(chapterMatch[1]), title: chapterMatch[2] };
    } else if (level2Match) {
      header.levels[1] = `${level2Match[1]} ${level2Match[2]}`;
      nextSymbolLevel = 2;
    } else if (level1Match) {
      header.levels[0] = `${level1Match[1]}. ${level1Match[2]}`;
      nextSymbolLevel = 1;
    } else if (symbolMatch && nextSymbolLevel < 2) {
      header.levels[nextSymbolLevel] = `${symbolMatch[1]} ${symbolMatch[2]}`;
      nextSymbolLevel += 1;
    } else {
      break;
    }
    header.bodyStart += 1;
    consumed += 1;
  }
  return header;
}

/**
 * 권고사항 장을 찾는다 — 제목에 `권고`가 들어간 장이다.
 *
 * 장 러닝 헤더가 **한 번도 없는 판본**(2026 계열)이 있으므로 반환값이 null일 수 있다.
 * 그때는 장으로 거르지 않는다 — 없는 장을 지어내지 않고, 대신 실패 가드가 이상을 드러낸다.
 */
function findRecommendationChapter(pages: string[]): string | null {
  for (const page of pages) {
    const header = parsePageHeader(page.split('\n').map((line) => line.trim()));
    if (header?.chapter && header.chapter.title.includes('권고')) return header.chapter.numeral;
  }
  return null;
}

/**
 * 대상 장의 본문 줄만 모은다.
 *
 * 페이지 헤더는 그 페이지가 **새로 선언하는 레벨만** 싣고 나머지는 생략하므로, 선언된 레벨만
 * 갱신하고 나머지는 직전 값을 상속한다 (페이지 패리티에 의존하지 않는다).
 */
function collectTargetChapterLines(pages: string[]): SourceLine[] {
  const targetChapter = findRecommendationChapter(pages);
  const collected: SourceLine[] = [];
  let chapter: string | null = null;
  let chapterTitle = '';
  let level1: string | undefined;
  let level2: string | undefined;

  for (const page of pages) {
    const lines = page.split('\n').map((line) => line.trim());
    const header = parsePageHeader(lines);
    if (!header) continue;

    if (header.chapter) {
      // 장 헤더는 러닝 헤더로도 반복 등장한다 — 실제로 장이 바뀔 때만 절을 초기화한다
      if (chapter !== header.chapter.numeral) {
        level1 = undefined;
        level2 = undefined;
      }
      chapter = header.chapter.numeral;
      chapterTitle = header.chapter.title;
    }
    if (header.levels[0] !== undefined) {
      // 1단계 절이 바뀌면 2단계 절을 초기화한다 (러닝 헤더로 같은 값이 반복될 때는 유지)
      if (level1 !== header.levels[0]) level2 = undefined;
      level1 = header.levels[0];
    }
    if (header.levels[1] !== undefined) level2 = header.levels[1];

    if (targetChapter !== null && chapter !== targetChapter) continue;

    const sectionPath = [
      ...(targetChapter !== null && chapter ? [`${chapter}. ${chapterTitle}`] : []),
      ...(level1 ? [level1] : []),
      ...(level2 ? [level2] : []),
    ];
    for (const text of lines.slice(header.bodyStart)) {
      if (text.length > 0) collected.push({ text, page: header.printedPage, sectionPath });
    }
  }
  return collected;
}

/** ASCII `IV`와 전각 `Ⅳ`를 같은 값(전각)으로 모은다 */
function normalizeRoman(numeral: string): string {
  return ROMAN_FULLWIDTH[numeral] ?? numeral;
}

/** 권고 블록을 분해해 섹션으로 묶는다. 청크가 없는 섹션은 만들지 않는다. */
function buildSections(lines: SourceLine[], blockStarts: MarkerOccurrence[]): IngestSection[] {
  const starts = blockStarts.map((o) => o.index);

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
    // `A / Moderate`처럼 슬래시 둘레에 공백이 오고 대소문자도 흔들린다 (docs/specs/20)
    const [rawCode, rawLevel] = token.split('/').map((part) => part.trim());
    const code = rawCode.toUpperCase();
    const recommendationGrade = rating(code, GRADE_LABELS[code] ?? code);
    // 합의 권고는 근거수준이 없는 것이 원칙이나, `GPP/CTB`처럼 고전문헌 근거를 명시하는 판본이 있다
    if (rawLevel === undefined) return { recommendationGrade };
    const level = EVIDENCE_CANONICAL[rawLevel.replace(/\s+/g, ' ').toLowerCase()] ?? rawLevel;
    return {
      recommendationGrade,
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
