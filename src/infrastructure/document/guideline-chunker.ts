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
/**
 * 임베딩 상한 안전망 — **모든** 청크가 이 길이 아래에 머문다 (docs/specs/19 「청크 길이 상한」).
 *
 * 경계 검출이 미지 판본에서 무너지면 청크가 블록 전체를 삼켜 임베딩 API가 400
 * (`maximum input length is 8192 tokens`)을 뱉고 그 문서는 영영 적재되지 않는다.
 * 실물 31건 2,881청크 실측에서 cl100k_base 토큰/문자 비율은 p50 0.921 · p99 1.234 · **max 1.313**이라
 * 6,000자면 최악 7,878토큰으로 8,192 아래다. 토크나이저를 이 순수 함수에 들이지 않으려고
 * 문자 수로 근사하며, 그 대가로 여유를 크게 잡는다.
 *
 * **정상 경로에서는 발동하지 않는다** — 경계가 제대로 잡힌 권고문·해설 청크는 이 길이에 한참 못 미친다.
 */
const CHUNK_MAX_CHARS = 6000;
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

/**
 * 권고 번호 표기 (docs/specs/24 기준 1·2).
 *
 * `R1`·`R5-1` 외에 **괄호 복합 좌표**가 있다 — 145는 임상질문과 권고안에 같은 좌표를 쓰므로
 * `R(Ⅰ-A-1)`·`R(Ⅲc-E-3)`·`R(Ⅱa-B-1-1)`처럼 전각 로마숫자·소문자 접미·다단 하이픈이 온다.
 * **번호는 원문 표기 그대로 담는다** — 재작성하면 원본 추적성이 깨진다(§23 기준 13과 같은 이유).
 */
const NUMBER_PATTERN = '(R(?:\\([^)]*\\d[^)]*\\)|\\d[0-9-]*))';
/** 마커 뒤에 제목이 붙는 판본이 있다 (`【R1】 삶의 질 개선`) — 번호만 취하고 제목은 버린다 */
const BRACKET_MARKER = new RegExp(`^【\\s*${NUMBER_PATTERN}\\s*】\\s*(.*)$`);
/**
 * 괄호(`【 】`)를 **아예 쓰지 않는** 판본의 마커 (docs/specs/24 기준 6·7).
 *
 * 219는 문서 전체에 `【 】`가 0건이고 본문 마커가 `R1`이다. 그런데 줄머리 `R1`은 **기존 성공
 * 문서에도 대량으로 있다** — 289(168건)·306(113건)·326(112건) 등 12건이 요약문에서
 * `R1 …권고문… B/Moderate` 형태로 권고를 재수록한다. 그 문서들이 파싱되는 이유는 본문이
 * `【R1】`을 쓰고 요약문은 장 판정 밖이라 버려지기 때문이다.
 *
 * 그래서 이 패턴은 **문서에 `【R…】`가 하나도 없을 때만** 유효하다(`markerPatternFor`) —
 * §20이 못박은 "문서에서 관측한 패턴으로 판정한다"의 직접 적용이다.
 */
const BARE_MARKER = new RegExp(`^${NUMBER_PATTERN}\\.?(?:\\s+(.*))?$`);
/**
 * 인제스트 대상 판정용 마커 (`containsRecommendationMarker`). 블록 마커와 두 가지가 다르다:
 * 줄 시작에 **앵커하지 않고**(본문·표 안의 재인용도 증거다), 번호에 **숫자를 최소 하나 요구**한다
 * (`【R】`·`【참고】`는 권고 마커가 아니다).
 *
 * 괄호 없는 판본(219)도 대상이므로 줄머리 형태를 함께 본다 — 여기서 false여야만 대상 아님이고,
 * 그 판정이 `SKIPPED`/`FAILED`를 가르므로 **넓게 잡을수록 조용한 건너뜀 대신 실패로 남는다**.
 */
const INGEST_TARGET_MARKER = new RegExp(`【\\s*${NUMBER_PATTERN}\\s*】`);
/**
 * 표 헤더 — 컬럼 구성이 판본마다 다르다 (docs/specs/24 기준 3·9).
 *
 * `권고안 번호 권고내용 권고등급/근거수준`(350) 외에 어절 사이 공백이 든 `권고 내용`과 뒤따르는
 * `참고문헌` 컬럼(219), `번호`·`권고내용` 컬럼이 아예 없는 형태(145)가 있다.
 */
const TABLE_HEADER = /^권고안(\s+번호)?\s+(권고\s*내용\s+)?권고등급\s*\/\s*근거수준/;
/**
 * 임상적 고려사항 제목. 대괄호를 두르는 판본이 있고(`[임상적 고려사항]`), 같은 블록에서
 * 대괄호 줄과 평문 줄이 잇달아 나오기도 한다 — 둘 다 제목으로 받고 **먼저 오는 쪽**을 경계로 쓴다.
 */
const CONSIDERATION_HEADER = /^\[?\s*임상적\s*고려사항\s*\]?$/;
/** 소절 마커: `(1)` 또는 `①`. 괄호 안이 숫자일 때만 마커다 — `(六君子湯)…` 같은 한자 줄바꿈과 구분한다 */
const SUBSECTION_MARKER = /^(?:\(\d+\)|[①-⑳])/;
const REFERENCES_MARKER = /^\[참고문헌\]$/;
/**
 * 참고문헌 소절 — 한 블록의 해설이 **닫히는 경계**다 (docs/specs/23 기준 3).
 *
 * `[참고문헌]`과 `(3) 참고문헌` 두 형태로 오며 후자는 `SUBSECTION_MARKER`에도 걸리므로,
 * 소절 판정보다 **먼저** 본다. 이 해제가 없으면 참고문헌 뒤의 미검출 마커까지 배제되어
 * 「청크가 없는 번호」가 조용히 사라진다.
 */
const REFERENCES_SECTION = /^(?:\[?\s*참고문헌\s*\]?|\(\d+\)\s*참고문헌)/;
/**
 * 합의 권고의 산문 등급 표기 (docs/specs/23 기준 1).
 *
 * 표도 등급 토큰도 없이 `【 R20 】 … 전문가그룹의 공식적 합의를 통해 권고한다.`처럼 문장 안에서만
 * 등급을 밝히는 판본이 있다(324). 이 문구가 곧 `GPP`의 증거다.
 *
 * **공백을 모두 지운 문자열에 대고 본다.** 지면 줄바꿈이 어절 한가운데를 자르는데
 * (`공식적 합`/`의를 통해` — R22, `공식적 합의`/`를 통해` — R26) 그 경계 공백은 PDF에 없어
 * 복원이 격조사 기반 추정이다. 공백을 지우면 어디서 잘렸든 같은 문자열이 되어 추정에 기대지 않는다.
 */
const CONSENSUS_STATEMENT = /합의를통해권고한다/;
/**
 * 권고 비도출 문구 (docs/specs/24 기준 4).
 *
 * 145의 `R(Ⅲa-D-11)`은 표 헤더도 등급도 권고문도 없고, 그 블록의 「권고안 도출에 대한 설명」이
 * 사유를 밝힌다 — "통계적 유의성이 없어서 **권고안 도출에 반영하지 않았다**". 원문 결함이 아니라
 * 원문의 의도이므로 면제(§23)가 아니라 배제로 다룬다. `CONSENSUS_STATEMENT`와 같게 **공백을 지운
 * 문자열**에 대고 본다 — 지면 줄바꿈이 문구 중간을 자르는데 그 경계 공백은 PDF에 없다.
 */
const NOT_DERIVED_STATEMENT = /권고안도출에반영하지않/;
/**
 * 해설 구간을 여는 소절 헤더 (docs/specs/23 기준 3).
 *
 * `SUBSECTION_MARKER`보다 **좁다** — 서지 항목의 연도가 줄 첫머리에 오면
 * (`(2013)는 648명의 …`) 소절로 오인되고, 그 뒤의 마커가 통째로 배제되어 미검출이 조용히
 * 사라진다(324 R26 실증). 실측 소절은 `(1)`~`(4)`뿐이라 자릿수로 가른다.
 * 공유 상수를 좁히지 않는 이유는 §19의 블록 분해가 그 넓은 판정에 의존하기 때문이다.
 */
const EXPLANATION_SUBSECTION = /^(?:\(\d{1,2}\)|[①-⑳])/;
/**
 * 등급 토큰. 판본마다 표기가 흔들린다 — 슬래시 둘레 공백(`A / Moderate`),
 * 대소문자(`B / Very low`·`B/MODERATE`). 대소문자 무시로 받고 코드는 정규형으로 모은다
 * (`MODERATE`와 `Moderate`가 서로 다른 코드가 되면 등급으로 거를 수 없다).
 * 근거수준은 `Very Low`를 `Low`보다 먼저 시도해야 잘리지 않는다.
 */
const EVIDENCE_LEVEL_PATTERN = '(?:Very\\s+Low|High|Moderate|Low|CTB|Insufficient)';
/**
 * `GPP`는 근거수준 없이 오기도 하고 `GPP/CTB`처럼 붙어 오기도 한다. `A`~`D`는 항상 근거수준을 동반한다.
 *
 * §23에서 셋이 늘었다 — `Inconclusive` 단독(권고 보류·비도출, 324·168), 근거수준이 **앞에 오는**
 * 순서(`Insufficient/GPP`, 291), 등급 문자 뒤 마침표(`C./Very Low`, 143).
 * 순서를 두 갈래로 나눠 받고, 어느 쪽이 등급이고 어느 쪽이 근거수준인지는 토큰 자체로 판정한다.
 */
const GRADE_PATTERN =
  `(Inconclusive|${EVIDENCE_LEVEL_PATTERN}\\s*/\\s*GPP` +
  `|GPP(?:\\s*/\\s*${EVIDENCE_LEVEL_PATTERN})?|[A-D]\\.?\\s*/\\s*${EVIDENCE_LEVEL_PATTERN})`;
/**
 * 등급 문자는 분명한데 근거수준이 정규형에 없는 판본 (`C/Vey Low` — 143의 원문 오타).
 *
 * 오타를 어휘에 박아 넣지 않으려고 **꼬리에 앵커된 별도 패턴**으로만 받는다 (docs/specs/23 기준 8).
 * `GRADE_TOKEN`(블록 판정)에는 넣지 않는다 — 근거수준 자리를 임의 낱말로 열면 본문 문장이
 * 등급으로 오인될 수 있고, 실측상 이 형태의 블록은 표 헤더로 이미 검출된다.
 */
const UNKNOWN_EVIDENCE_TAIL =
  /(?:^|\s)([A-D])\.?\s*\/\s*([A-Za-z]+(?:\s+[A-Za-z]+)?)\s*(?:\d+(?:\s*[,\-–~]\s*\d+)*\)?)?$/;
const GRADE_TOKEN = new RegExp(`(?:^|\\s)${GRADE_PATTERN}(?=\\s|$)`, 'i');
const GRADE_TAIL = new RegExp(`(?:^|\\s)${GRADE_PATTERN}(?:\\s.*)?$`, 'i');

/** 원문 표기의 대소문자 흔들림을 정규형으로 모은다 */
const EVIDENCE_CANONICAL: Record<string, string> = {
  'very low': 'Very Low',
  high: 'High',
  moderate: 'Moderate',
  low: 'Low',
  ctb: 'CTB',
  insufficient: 'Insufficient',
};
/**
 * 권고등급 정규형. 슬래시 양쪽 중 **어느 쪽이 등급인지**를 이 표로 판정하므로,
 * 표기 순서에 의존하지 않는다 (`Insufficient/GPP`와 `GPP/Insufficient`가 같은 결과다).
 */
const GRADE_CANONICAL: Record<string, string> = {
  a: 'A',
  b: 'B',
  c: 'C',
  d: 'D',
  gpp: 'GPP',
  inconclusive: 'Inconclusive',
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
  // 근거가 부족하거나 국내 상황에 맞지 않아 권고 자체를 내지 않은 경우다 (docs/specs/23)
  Inconclusive: '권고 보류',
};

const EVIDENCE_LABELS: Record<string, string> = {
  High: '높음',
  Moderate: '중등도',
  Low: '낮음',
  'Very Low': '매우 낮음',
  // 지침이 직접 정의한다 — "현대적 연구방법론을 활용한 근거연구가 아직 수행되지 않았으나,
  // 기성 한의서 등 고전 텍스트에 근거가 있는 경우 CTB (Classical Text-based)를 부여"
  CTB: '고전문헌 근거',
  Insufficient: '근거 불충분',
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
  /**
   * 권고등급은 읽었으나 근거수준이 정규형에 없던 경우의 **원문 표기** (docs/specs/23 기준 8).
   *
   * `C/Vey Low`(원문 오타)처럼 등급 문자는 분명한데 근거수준만 미상인 판본이 있다. 오타를 어휘에
   * 박아 넣지 않으려고 등급 추출은 성공으로 두지만, 그냥 버리면 조용한 유실이 되므로 여기 모아
   * `verify:templates`가 문서별로 보고한다. `evidenceLevel`은 비운다 — 정규형 없는 코드가 들어가면
   * §14의 등급 필터가 「Moderate 이상」을 거를 때 어디에도 속하지 않는 값이 끼어든다.
   */
  unknownEvidenceLevels: { recommendationNumber: string; raw: string }[];
  /**
   * 번호는 발급됐으나 원문이 **권고를 내지 않은** 번호 (docs/specs/24 기준 4·5).
   *
   * 145는 임상질문과 권고안에 같은 좌표를 쓰므로(`Q(Ⅲa-D-11)` ↔ `R(Ⅲa-D-11)`), 통계적 유의성이
   * 없어 권고안 도출에 반영하지 않은 항목도 마커가 자리를 지킨다. 원문 결함이 아니라 원문의 의도라
   * `uniqueNumbers`에서 빼되, **그냥 버리면 조용한 유실**이 되므로 여기 모아 기대치에 동결한다 —
   * 1건이 40건이 되면 원문 성격의 변화나 배제 규칙의 드리프트 신호다 (§23 기준 8과 같은 이유).
   */
  notDerived: string[];
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
  // 문서가 쓰는 마커 문법은 **관측으로** 정한다 (docs/specs/24 기준 6·7)
  const marker = markerPatternFor(pages);
  const lines = collectTargetChapterLines(pages);
  const occurrences = findMarkerOccurrences(lines, marker);
  const blockStarts = occurrences.filter((o) => isBlockStart(lines, o.index, marker));
  const { sections, unknownEvidenceLevels } = buildSections(lines, blockStarts, marker);

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

  const { counted, notDerived } = countableNumbers(lines, occurrences, blockStarts);
  const uniqueNumbers = counted;
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
      unknownEvidenceLevels,
      notDerived,
    },
  };
}

/**
 * 문서가 쓰는 마커 문법을 **관측으로** 고른다 (docs/specs/24 기준 6·7).
 *
 * `【R…】`가 한 번이라도 보이면 그 문서는 괄호 판본이므로 괄호 없는 줄머리 `R1`은 마커가 아니다 —
 * 요약문 재수록이기 때문이다. 필터 **이전** 원본을 보는 이유는 `containsRecommendationMarker`와
 * 같다: 장 판정이 마커 페이지를 전량 탈락시킨 경우와 구분해야 한다.
 */
function markerPatternFor(pages: string[]): RegExp {
  return pages.some((page) => INGEST_TARGET_MARKER.test(page)) ? BRACKET_MARKER : BARE_MARKER;
}

/**
 * 원본 페이지에 권고 마커가 하나라도 있는가 — **인제스트 대상 판정용**이다 (docs/specs/20 계열 D).
 *
 * `chunkNckmGuideline`의 `uniqueNumbers`와 다른 것을 본다. 그쪽은 `collectTargetChapterLines`가
 * 장·페이지를 걸러낸 **뒤**의 마커라, 0이어도 「문서에 마커가 없다」와 「장 판정이 마커 페이지를
 * 전량 탈락시켰다」를 구분하지 못한다 — 후자는 §20이 계열 B·C에서 겪은 파서 결함 그 자체다.
 * 이 함수는 필터 **이전** 원본을 보므로 그 둘을 가른다: 여기서 false여야만 대상 아님이다.
 *
 * 줄 어디에 있든 센다(블록 마커는 줄 시작에 앵커돼 있다) — 목차·결과요약표의 재인용도
 * 「이 문서는 【R】 체계를 쓴다」는 증거이며, 넓게 잡을수록 조용한 건너뜀 대신 실패로 남는다.
 */
export function containsRecommendationMarker(pages: string[]): boolean {
  if (pages.some((page) => INGEST_TARGET_MARKER.test(page))) return true;
  // 괄호를 아예 쓰지 않는 판본(219) — 줄머리 마커 뒤에 표 헤더나 등급이 따라오는 줄이 있어야
  // 「이 문서는 권고 체계를 쓴다」의 증거다. 줄머리 `R1`만으로 받으면 서지·수식이 오탐된다.
  return pages.some((page) => {
    const lines = page.split('\n').map((line) => line.trim());
    return lines.some((line, index) => {
      if (!BARE_MARKER.test(line)) return false;
      const window = lines.slice(Math.max(0, index - 1), index + 1 + BLOCK_EVIDENCE_WINDOW);
      return window.some((near) => TABLE_HEADER.test(near) || GRADE_TOKEN.test(near));
    });
  });
}

/**
 * 가드가 셀 권고 번호를 고른다 (docs/specs/23 기준 3·4).
 *
 * 블록이 아닌 마커라도 전부 세면 **근거 서술이 참조한 번호**까지 「청크가 없는 번호」가 된다
 * (편두통 171: 근거 소절 안의 `R1-3`·`R13-4` 18개). 반대로 전부 빼면 진짜 미검출이 조용히
 * 사라진다 — 그래서 배제는 **블록의 해설 구간 안**으로만 한정하고, 참고문헌에서 해제한다.
 * 해설은 `(1) 배경` → `(2) 근거` → `(3) 참고문헌`으로 가고 참고문헌에서 그 블록이 닫힌다.
 */
function countableNumbers(
  lines: SourceLine[],
  occurrences: MarkerOccurrence[],
  blockStarts: MarkerOccurrence[],
): { counted: string[]; notDerived: string[] } {
  const startIndexes = new Set(blockStarts.map((o) => o.index));
  const numberAt = new Map(occurrences.map((o) => [o.index, o.number]));
  const notDerived = notDerivedNumbers(lines, occurrences, startIndexes);
  const counted = new Set<string>();
  let insideExplanation = false;

  lines.forEach((line, index) => {
    if (startIndexes.has(index)) {
      // 새 블록이 열리면 직전 블록의 해설 구간은 끝난다
      insideExplanation = false;
    } else if (REFERENCES_SECTION.test(line.text)) {
      // `(3) 참고문헌`은 소절 패턴에도 걸리므로 반드시 소절 판정보다 먼저 본다
      insideExplanation = false;
    } else if (EXPLANATION_SUBSECTION.test(line.text)) {
      insideExplanation = true;
    }

    const number = numberAt.get(index);
    if (number === undefined) return;
    if (notDerived.includes(number)) return;
    if (startIndexes.has(index) || !insideExplanation) counted.add(number);
  });

  return { counted: [...counted], notDerived };
}

/**
 * 번호는 발급됐으나 원문이 **권고를 내지 않은** 번호를 고른다 (docs/specs/24 기준 4·5).
 *
 * 판정은 **두 조건의 결합**이다 — ⑴ 그 마커가 블록이 아니고 ⑵ 그 마커 구간에 비도출 문구가 있다.
 * 어느 한쪽만으로는 정상 권고를 잘라낸다: 141·352는 표 헤더·등급을 갖춘 **정상 블록의 해설 안**에
 * 같은 문구를 두고도 현행 `status:"OK"`다.
 */
function notDerivedNumbers(
  lines: SourceLine[],
  occurrences: MarkerOccurrence[],
  startIndexes: Set<number>,
): string[] {
  const numbers: string[] = [];
  occurrences.forEach((occurrence, order) => {
    if (startIndexes.has(occurrence.index)) return;
    const end = occurrences[order + 1]?.index ?? lines.length;
    // 지면 줄바꿈이 문구 중간을 자르므로 **공백을 지운 문자열**에 대고 본다 (§23 합의 문구와 같은 이유)
    const segment = lines
      .slice(occurrence.index, end)
      .map((line) => line.text)
      .join('')
      .replace(/\s+/g, '');
    if (NOT_DERIVED_STATEMENT.test(segment)) numbers.push(occurrence.number);
  });
  return [...new Set(numbers)];
}

interface MarkerOccurrence {
  index: number;
  number: string;
}

function findMarkerOccurrences(lines: SourceLine[], marker: RegExp): MarkerOccurrence[] {
  const occurrences: MarkerOccurrence[] = [];
  lines.forEach((line, index) => {
    const number = marker.exec(line.text)?.[1];
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
function isBlockStart(lines: SourceLine[], index: number, marker: RegExp): boolean {
  // 괄호 없는 판본은 표 헤더가 마커 **앞**에 오고 권고문·등급이 마커 줄에 이어붙는다 —
  // 그래서 그 판본에서만 마커 줄 자신을 증거에 넣는다 (docs/specs/24 기준 8·9).
  // 괄호 판본까지 넓히면 마커 줄에 등급이 붙은 재인용이 블록으로 오인돼 §20 기준 2가 무력해진다.
  const from = marker === BARE_MARKER ? index : index + 1;
  // **다음 마커에서 자른다** — 넘어가면 뒤 블록의 표 헤더·등급을 자기 증거로 쓴다.
  // 권고 없는 마커 바로 뒤에 정상 블록이 붙는 배치(145의 비도출 항목)가 그 함정이다.
  const window: SourceLine[] = [];
  for (let at = from; at < Math.min(lines.length, index + 1 + BLOCK_EVIDENCE_WINDOW); at += 1) {
    if (at !== index && marker.test(lines[at].text)) break;
    window.push(lines[at]);
  }
  if (window.some((line) => TABLE_HEADER.test(line.text) || GRADE_TOKEN.test(line.text))) {
    return true;
  }
  return isConsensusBlock(lines.slice(index, index + 1 + BLOCK_EVIDENCE_WINDOW), marker);
}

/**
 * 마커로 시작하는 구간의 **첫 문장**이 합의 문구로 끝나는가 (docs/specs/23 기준 1).
 *
 * 마커 줄에 권고 문장이 이어붙는 판본이라 마커 줄의 뒤 텍스트부터 이어 붙이고, 문장이 끝나거나
 * 다음 마커를 만나면 멈춘다. 해설 전체를 훑으면 근거 서술에 나온 「합의」까지 걸린다.
 */
function isConsensusBlock(block: SourceLine[], marker: RegExp): boolean {
  const matched = marker.exec(block[0]?.text ?? '');
  if (!matched) return false;

  const hasConsensus = (text: string): boolean =>
    CONSENSUS_STATEMENT.test(text.replace(/\s+/g, ''));

  let sentence = matched[2] ?? '';
  if (hasConsensus(sentence)) return true;
  for (const line of block.slice(1)) {
    if (marker.test(line.text)) break;
    sentence = `${sentence}${line.text}`;
    if (hasConsensus(sentence)) return true;
    if (SENTENCE_END.test(line.text)) break;
  }
  return false;
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
function buildSections(
  lines: SourceLine[],
  blockStarts: MarkerOccurrence[],
  marker: RegExp,
): { sections: IngestSection[]; unknownEvidenceLevels: { recommendationNumber: string; raw: string }[] } {
  const starts = blockStarts.map((o) => o.index);

  const sections: IngestSection[] = [];
  const unknownEvidenceLevels: { recommendationNumber: string; raw: string }[] = [];
  starts.forEach((start, order) => {
    const end = order + 1 < starts.length ? starts[order + 1] : lines.length;
    const { chunks, unknownEvidence } = buildBlockChunks(lines.slice(start, end), marker);
    if (unknownEvidence) unknownEvidenceLevels.push(unknownEvidence);
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
  return { sections, unknownEvidenceLevels };
}

/** 블록을 이루는 구간의 종류 (docs/specs/19 「블록 경계」) */
type SegmentKind = 'statement' | 'consideration' | 'explanation' | 'references';

interface BlockSegment {
  kind: SegmentKind;
  /** 반열림 구간 [start, end) */
  start: number;
  end: number;
}

/**
 * 블록을 구간으로 분해한다 — **이 파서의 급소**다 (docs/specs/19 「블록 경계」).
 *
 * 예전에는 구간마다 기대하는 경계 하나를 찾고 못 찾으면 `block.length`로 떨어졌다. 그래서
 * 판본이 그 경계를 안 쓰면 구간이 블록 전체를 삼켰다 — 권고문 청크에 해설 전문과 참고문헌 서지가
 * 통째로 들어가(실물 671쌍 중 100쌍) 같은 텍스트가 두 번 적재됐고, 그중 13건은 임베딩 8192토큰
 * 상한을 넘겨 문서째 적재에 실패했다.
 *
 * 그래서 **어느 경계가 먼저 오는지 가정하지 않는다.** 표지 줄을 만나는 순서대로 구간을 끊을 뿐이다.
 * 실물에서 관측된 배치가 판본마다 다르기 때문이다:
 * - 고려사항 제목이 아예 없음 (163·170·351)
 * - 고려사항이 해설보다 **뒤**에 옴 (149)
 * - 고려사항이 해설 **중간**에 끼어 해설이 두 동강 남 (149 R2·R4) — 뒷조각도 해설로 살린다
 * - `[참고문헌]` 표지가 없음 (163·170·149)
 */
function splitBlockSegments(block: SourceLine[], bodyStart: number): BlockSegment[] {
  const segments: BlockSegment[] = [];
  const marks: { at: number; kind: SegmentKind }[] = [];
  for (let index = bodyStart; index < block.length; index += 1) {
    const { text } = block[index];
    const kind: SegmentKind | null = CONSIDERATION_HEADER.test(text)
      ? 'consideration'
      : REFERENCES_MARKER.test(text)
        ? 'references'
        : SUBSECTION_MARKER.test(text)
          ? 'explanation'
          : null;
    if (kind) marks.push({ at: index, kind });
  }

  // 첫 표지 앞이 권고 문장이다. 표지가 하나도 없으면 블록 전체가 권고 문장이다.
  const firstMark = marks.length > 0 ? marks[0].at : block.length;
  if (firstMark > bodyStart) {
    segments.push({ kind: 'statement', start: bodyStart, end: firstMark });
  }
  marks.forEach((mark, order) => {
    const end = order + 1 < marks.length ? marks[order + 1].at : block.length;
    const previous = segments[segments.length - 1];
    // 소절 마커가 잇달아 오거나 고려사항 제목이 두 표기로 겹쳐 나오면 한 구간이다
    if (previous && previous.kind === mark.kind && previous.end === mark.at) {
      previous.end = end;
      return;
    }
    segments.push({ kind: mark.kind, start: mark.at, end });
  });

  // `[참고문헌]`부터 블록 끝까지는 버린다 (docs/specs/19 수용 기준 10)
  const referencesAt = segments.findIndex((segment) => segment.kind === 'references');
  return referencesAt === -1 ? segments : segments.slice(0, referencesAt);
}

interface BlockChunks {
  chunks: IngestChunk[];
  /** 등급 문자는 읽었으나 근거수준이 정규형에 없던 경우 (docs/specs/23 기준 8) */
  unknownEvidence?: { recommendationNumber: string; raw: string };
}

/** 블록 하나 → 권고문 청크 1개 + 해설 청크 1개 이상 */
function buildBlockChunks(block: SourceLine[], marker: RegExp): BlockChunks {
  const recommendationNumber = marker.exec(block[0].text)?.[1];
  if (!recommendationNumber) return { chunks: [] };

  const bodyStart = TABLE_HEADER.test(block[1]?.text ?? '') ? 2 : 1;
  const segments = splitBlockSegments(block, bodyStart);
  const linesOf = (kind: SegmentKind): SourceLine[] =>
    segments
      .filter((segment) => segment.kind === kind)
      .flatMap((segment) => block.slice(segment.start, segment.end));

  // 마커 줄에 **권고 문장 본문**이 이어붙는 두 경로가 있다:
  // ⑴ 합의 권고 (docs/specs/23 기준 1) ⑵ 괄호 없는 판본 (docs/specs/24 기준 8).
  // 마커 줄을 언제나 버리는 §20 기준 10은 붙은 것이 *제목*일 때의 규칙이므로, 이 두 경로에만
  // 예외를 둔다 — 그러지 않으면 content가 잘린 권고문으로 적재된다.
  const consensus = isConsensusBlock(block, marker);
  const trailing = marker.exec(block[0].text)?.[2]?.trim() ?? '';
  const leading: SourceLine[] =
    (consensus || marker === BARE_MARKER) && trailing.length > 0
      ? [{ ...block[0], text: trailing }]
      : [];

  const statementLines = [...leading, ...linesOf('statement')];
  const extracted = extractGrades(statementLines);
  // 표도 등급 토큰도 없이 문장으로만 밝힌 합의 권고 — 그 문구 자체가 GPP의 증거다
  const grades: ExtractedGrades =
    extracted.recommendationGrade === undefined && consensus
      ? { recommendationGrade: rating('GPP', GRADE_LABELS.GPP) }
      : extracted;

  // 등급 토큰과 뒤따르는 참고문헌 번호는 본문에서 제거한다 — 등급은 메타데이터에 있고,
  // 참고문헌 번호는 가리킬 서지 목록을 버리므로 본문에 남기면 잔여물이 된다.
  const statement = toParagraphs(
    statementLines.map((line) => ({
      ...line,
      // 정규형으로 못 읽은 등급도 본문에서는 걷어낸다 — 읽기 실패가 잔여물로 남을 이유는 없다
      text: line.text.replace(GRADE_TAIL, '').replace(UNKNOWN_EVIDENCE_TAIL, ''),
    })),
    marker,
  );
  const consideration = toParagraphs(linesOf('consideration'), marker);

  const chunks: IngestChunk[] = [];
  splitByLength([...statement, ...consideration], CHUNK_MAX_CHARS).forEach((part, index) => {
    chunks.push({
      content: part.text,
      recommendationNumber,
      // 등급은 **권고 문장**에 부여된 것이다. 안전망이 권고문을 쪼갠 뒤쪽 조각에까지 복사하면
      // 같은 번호로 등급 있는 청크가 둘이 되어 §20의 duplicated 진단이 재인용 오인으로 오작동한다.
      recommendationGrade: index === 0 ? grades.recommendationGrade : undefined,
      evidenceLevel: index === 0 ? grades.evidenceLevel : undefined,
      pageStart: part.pageStart,
      pageEnd: part.pageEnd,
    });
  });

  const explanation = toParagraphs(linesOf('explanation'), marker);
  for (const part of splitByLength(explanation, EXPLANATION_MAX_CHARS)) {
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
  return {
    chunks,
    unknownEvidence:
      grades.unknownEvidence !== undefined
        ? { recommendationNumber, raw: grades.unknownEvidence }
        : undefined,
  };
}

interface ExtractedGrades {
  recommendationGrade?: IngestRating;
  evidenceLevel?: IngestRating;
  /** 등급 문자는 읽었으나 근거수준이 정규형에 없던 원문 표기 (docs/specs/23 기준 8) */
  unknownEvidence?: string;
}

function extractGrades(statementLines: SourceLine[]): ExtractedGrades {
  for (const line of statementLines) {
    const token = GRADE_TAIL.exec(line.text)?.[1];
    if (token) return classifyGradeToken(token);

    // 정규형 어휘로는 못 읽는 근거수준 — 등급 문자만 살리고 표기는 진단으로 넘긴다
    const unknown = UNKNOWN_EVIDENCE_TAIL.exec(line.text);
    if (unknown) {
      const code = GRADE_CANONICAL[unknown[1].toLowerCase()] ?? unknown[1].toUpperCase();
      return {
        recommendationGrade: rating(code, GRADE_LABELS[code] ?? code),
        unknownEvidence: unknown[2].replace(/\s+/g, ' ').trim(),
      };
    }
  }
  return {};
}

/**
 * 등급 토큰을 권고등급·근거수준으로 가른다.
 *
 * **위치가 아니라 토큰 자체로 판정한다** — `Insufficient/GPP`처럼 근거수준이 앞에 오는 판본이
 * 있어(291) 앞을 등급으로 고정하면 뒤집힌 채로 들어간다 (docs/specs/23 기준 6).
 */
function classifyGradeToken(token: string): ExtractedGrades {
  let recommendationGrade: IngestRating | undefined;
  let evidenceLevel: IngestRating | undefined;

  // `A / Moderate`처럼 슬래시 둘레에 공백이 오고 대소문자도 흔들린다 (docs/specs/20).
  // 등급 문자 뒤에 마침표가 붙는 판본도 있다 (`C./Very Low`, 143).
  for (const part of token.split('/')) {
    const bare = part.trim().replace(/\.$/, '');
    const asGrade = GRADE_CANONICAL[bare.toLowerCase()];
    if (asGrade !== undefined) {
      recommendationGrade = rating(asGrade, GRADE_LABELS[asGrade] ?? asGrade);
      continue;
    }
    const asLevel = EVIDENCE_CANONICAL[bare.replace(/\s+/g, ' ').toLowerCase()] ?? bare;
    evidenceLevel = rating(asLevel, EVIDENCE_LABELS[asLevel] ?? asLevel);
  }
  // 합의 권고는 근거수준이 없는 것이 원칙이나, `GPP/CTB`처럼 고전문헌 근거를 명시하는 판본이 있다
  return { recommendationGrade, evidenceLevel };
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
function toParagraphs(lines: SourceLine[], marker: RegExp): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let current: Paragraph | null = null;

  const flush = (): void => {
    if (current && current.text.length > 0) paragraphs.push(current);
    current = null;
  };

  for (const line of lines) {
    if (line.text.length === 0) continue;
    if (isStructuralLine(line.text, marker)) {
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

function isStructuralLine(text: string, marker: RegExp): boolean {
  return (
    CONSIDERATION_HEADER.test(text) ||
    SUBSECTION_MARKER.test(text) ||
    REFERENCES_MARKER.test(text) ||
    marker.test(text) ||
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

/**
 * 누적 길이가 상한을 넘기 직전의 문단 경계에서 끊는다.
 *
 * 문단 경계가 **없을 수도 있다** — 종결부호가 오지 않는 표·목록 줄이 길게 이어지면 하드 랩 복원이
 * 그것을 한 문단으로 잇는다. 그래서 문단 자체를 먼저 상한 이하로 쪼갠 뒤 묶는다. 예전에는 버퍼가
 * 비어 있으면 길이를 보지 않고 담아, 문단 하나가 상한을 넘으면 그대로 통과시켰다.
 */
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
    for (const piece of splitOversizedParagraph(paragraph, maxChars)) {
      if (buffer.length > 0 && length + piece.text.length > maxChars) flush();
      buffer.push(piece);
      length += piece.text.length + 1;
    }
  }
  flush();
  return parts;
}

/**
 * 상한을 넘는 문단 하나를 문장 경계로, 그마저 없으면 상한 위치에서 강제로 쪼갠다 (안전망).
 *
 * 조각들은 원 문단의 페이지 범위를 그대로 물려받는다 — 문단 안쪽 어디서 페이지가 넘어갔는지는
 * 하드 랩 복원이 이미 지워버려서 알 수 없다. 좁혀 말하는 것보다 넓게 말하는 편이 인용에 안전하다.
 */
function splitOversizedParagraph(paragraph: Paragraph, maxChars: number): Paragraph[] {
  if (paragraph.text.length <= maxChars) return [paragraph];

  const pieces: Paragraph[] = [];
  const at = (text: string): Paragraph => ({
    text,
    pageStart: paragraph.pageStart,
    pageEnd: paragraph.pageEnd,
  });
  let rest = paragraph.text;
  while (rest.length > maxChars) {
    const cut = lastSentenceEnd(rest.slice(0, maxChars)) || maxChars;
    pieces.push(at(rest.slice(0, cut)));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) pieces.push(at(rest));
  return pieces;
}

/** 문자열 안 마지막 종결부호 **다음** 위치. 없으면 0 */
function lastSentenceEnd(text: string): number {
  for (let index = text.length - 1; index > 0; index -= 1) {
    if ('.!?。'.includes(text[index])) return index + 1;
  }
  return 0;
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
