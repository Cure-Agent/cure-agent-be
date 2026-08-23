/**
 * flag-first 구조화 답변의 요청 형식과 증분 파서 (docs/specs/40).
 *
 * **전체 버퍼링을 하지 않는다.** 스키마가 `insufficient_evidence`를 `answer`보다 먼저 선언하고
 * structured outputs는 스키마 순서로 생성하므로, 플래그는 답변 첫 글자보다 먼저 도착한다.
 * 그 뒤 `answer` 문자열은 오는 대로 델타로 흘린다 — TTFT는 구조화 이전과 같다. §29가 리랭크
 * +1초를 이미 얹은 위에 답변 생성 전체를 더할 수 없다.
 *
 * 파싱 실패의 등급은 **판정 확정 시점**으로 갈린다:
 * - 확정 **전** 실패 → `LlmProviderError`. 아직 아무 델타도 나가지 않았으므로 게이트웨이가
 *   다음 프로바이더로 폴백할 수 있다.
 * - 확정 **후** 실패(잘림·군더더기) → 조용한 중단. 지금까지 흘린 델타로 답변을 완료한다 —
 *   오늘의 출력 상한 잘림 처리와 같다.
 */
import { LlmAnswerChunk, LlmProviderError } from '../llm-provider.port';

const FLAG_KEY = 'insufficient_evidence';
const ASPECTS_KEY = 'missing_aspects';
const ANSWER_KEY = 'answer';

/**
 * structured outputs 요청 형식 — **필드 선언 순서가 계약이다**(플래그 → 축 → 본문).
 * `minItems`는 structured outputs가 지원하지 않으므로 축이 비어 있는지는 코드가 판정한다.
 */
export const ANSWER_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'guideline_answer',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        insufficient_evidence: { type: 'boolean' },
        missing_aspects: { type: 'array', items: { type: 'string' } },
        answer: { type: 'string' },
      },
      // strict 모드는 전 속성을 required로 요구한다
      required: [FLAG_KEY, ASPECTS_KEY, ANSWER_KEY],
      additionalProperties: false,
    },
  },
};

type State = 'object' | 'key' | 'colon' | 'value' | 'answer-open' | 'answer' | 'next' | 'done';

/** `\uXXXX`는 4자리가 다 와야 해석하므로 여기서 제외한다 */
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

export class StructuredAnswerParser {
  private buffer = '';
  private cursor = 0;
  private state: State = 'object';
  private key = '';
  private flag: boolean | null = null;
  private aspects: string[] = [];
  private aspectsSeen = false;
  private verdictSent = false;
  /** 판정 확정 전에 도착한 본문 — 확정 시 흘리거나(false) 버린다(true) */
  private held = '';
  /** 판정 확정 이후의 중단(기권 확정·잘림·군더더기) — 이후 입력은 보지 않는다 */
  private stopped = false;

  push(text: string): LlmAnswerChunk[] {
    if (this.stopped || this.state === 'done') return [];
    this.buffer += text;
    return this.drain();
  }

  /** 스트림 종료. 판정 확정 전에 끝났으면 판정도 답도 못 받은 응답이므로 실패다 */
  finish(): LlmAnswerChunk[] {
    if (this.verdictSent || this.stopped) return [];
    throw new LlmProviderError('구조화 답변이 판정 전에 끝났습니다', { retryable: true });
  }

  private drain(): LlmAnswerChunk[] {
    const out: LlmAnswerChunk[] = [];
    try {
      while (this.step(out)) {
        /* 소비할 수 있는 만큼 */
      }
    } catch (error) {
      if (!this.verdictSent) throw error;
      this.stopped = true;
    }
    this.buffer = this.buffer.slice(this.cursor);
    this.cursor = 0;
    return out;
  }

  /** 한 조각을 소비하면 true, 입력이 더 필요하면 false */
  private step(out: LlmAnswerChunk[]): boolean {
    switch (this.state) {
      case 'done':
        return false;

      case 'object': {
        const at = this.skipSpace();
        if (at === null) return false;
        if (this.buffer[at] !== '{') throw malformed();
        this.cursor = at + 1;
        this.state = 'key';
        return true;
      }

      case 'key': {
        const at = this.skipSpace();
        if (at === null) return false;
        if (this.buffer[at] === '}') return this.closeObject(at, out);
        const parsed = this.readString(at);
        if (!parsed) return false;
        this.key = parsed.value;
        this.cursor = parsed.next;
        this.state = 'colon';
        return true;
      }

      case 'colon': {
        const at = this.skipSpace();
        if (at === null) return false;
        if (this.buffer[at] !== ':') throw malformed();
        this.cursor = at + 1;
        this.state = this.key === ANSWER_KEY ? 'answer-open' : 'value';
        return true;
      }

      case 'value': {
        const at = this.skipSpace();
        if (at === null) return false;
        const parsed = this.readValue(at);
        if (!parsed) return false;
        this.assign(this.key, parsed.value);
        this.cursor = parsed.next;
        this.state = 'next';
        this.emitVerdict(out, false);
        return true;
      }

      case 'answer-open': {
        const at = this.skipSpace();
        if (at === null) return false;
        // 본문 시작 = 판정 필드가 모두 지나갔다는 뜻이다 (flag-first 스키마)
        this.emitVerdict(out, true);
        if (this.stopped) return false;
        if (this.buffer[at] !== '"') throw malformed();
        this.cursor = at + 1;
        this.state = 'answer';
        return true;
      }

      case 'answer':
        return this.readAnswerRun(out);

      case 'next': {
        const at = this.skipSpace();
        if (at === null) return false;
        if (this.buffer[at] === ',') {
          this.cursor = at + 1;
          this.state = 'key';
          return true;
        }
        if (this.buffer[at] === '}') return this.closeObject(at, out);
        throw malformed();
      }
    }
  }

  private closeObject(at: number, out: LlmAnswerChunk[]): boolean {
    this.cursor = at + 1;
    this.state = 'done';
    // 본문이 판정보다 먼저 온 응답(스키마 순서 위반)도 여기서 닫힌다 — 보류분을 흘린다
    this.emitVerdict(out, true);
    this.flushHeld(out);
    return true;
  }

  /**
   * 판정을 1회 방출한다. `force`는 본문 시작·객체 종료처럼 「판정 필드가 더 오지 않는」 지점이다.
   * 기권 판정이면 여기서 멈춘다 — 본문을 **파싱하지도 델타를 내지도 않는다**.
   */
  private emitVerdict(out: LlmAnswerChunk[], force: boolean): void {
    if (this.verdictSent || this.flag === null) return;
    if (!force && !this.aspectsSeen) return;

    this.verdictSent = true;
    out.push({
      kind: 'verdict',
      insufficientEvidence: this.flag,
      missingAspects: this.aspects,
    });
    if (this.flag) {
      this.held = '';
      this.stopped = true;
      return;
    }
    this.flushHeld(out);
  }

  private flushHeld(out: LlmAnswerChunk[]): void {
    if (this.held.length === 0) return;
    const text = this.held;
    this.held = '';
    out.push({ kind: 'delta', text });
  }

  /** 판정 전에 온 본문은 보류한다 — 판정이 서기 전에 흘리면 기권을 되돌릴 수 없다 */
  private emitAnswer(text: string, out: LlmAnswerChunk[]): void {
    if (text.length === 0) return;
    if (!this.verdictSent) {
      this.held += text;
      return;
    }
    out.push({ kind: 'delta', text });
  }

  /** 닫는 따옴표까지, 또는 도착한 만큼 본문을 해석해 흘린다 */
  private readAnswerRun(out: LlmAnswerChunk[]): boolean {
    let index = this.cursor;
    let decoded = '';

    while (index < this.buffer.length) {
      const char = this.buffer[index];
      if (char === '"') {
        this.cursor = index + 1;
        this.state = 'next';
        this.emitAnswer(decoded, out);
        return true;
      }
      if (char === '\\') {
        const escape = this.readEscape(index);
        if (!escape) break; // 이스케이프가 아직 다 오지 않았다
        decoded += escape.value;
        index = escape.next;
        continue;
      }
      decoded += char;
      index += 1;
    }

    this.cursor = index;
    this.emitAnswer(decoded, out);
    return false;
  }

  private readEscape(at: number): { value: string; next: number } | null {
    const code = this.buffer[at + 1];
    if (code === undefined) return null;
    if (code === 'u') {
      const hex = this.buffer.slice(at + 2, at + 6);
      if (hex.length < 4) return null;
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw malformed();
      return { value: String.fromCharCode(Number.parseInt(hex, 16)), next: at + 6 };
    }
    const simple = SIMPLE_ESCAPES[code];
    if (simple === undefined) throw malformed();
    return { value: simple, next: at + 2 };
  }

  /** 완결된 JSON 값 하나 — 미완이면 null(커서를 움직이지 않는다) */
  private readValue(at: number): { value: unknown; next: number } | null {
    const char = this.buffer[at];
    if (char === '"') {
      const parsed = this.readString(at);
      return parsed ? { value: parsed.value, next: parsed.next } : null;
    }
    if (char === '[' || char === '{') {
      const end = this.findStructureEnd(at);
      if (end === null) return null;
      return { value: JSON.parse(this.buffer.slice(at, end)), next: end };
    }

    const rest = this.buffer.slice(at);
    const literal = rest.match(/^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!literal) {
      // 리터럴이 아직 덜 온 것과 애초에 값이 아닌 것을 가른다
      if (/^(t|tr|tru|f|fa|fal|fals|n|nu|nul|-|\d+\.?|\d+[eE][+-]?)$/.test(rest)) return null;
      throw malformed();
    }
    const next = at + literal[1].length;
    // 숫자는 구분자가 와야 끝난 것이 확실하다 (12가 123의 앞부분일 수 있다)
    if (next === this.buffer.length && !/^(true|false|null)$/.test(literal[1])) return null;
    return { value: JSON.parse(literal[1]), next };
  }

  /** 문자열 리터럴 — 이스케이프를 존중해 닫는 따옴표를 찾는다. 미완이면 null */
  private readString(at: number): { value: string; next: number } | null {
    if (this.buffer[at] !== '"') throw malformed();
    let index = at + 1;
    while (index < this.buffer.length) {
      const char = this.buffer[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '"') {
        return { value: JSON.parse(this.buffer.slice(at, index + 1)) as string, next: index + 1 };
      }
      index += 1;
    }
    return null;
  }

  /** 배열·객체가 닫히는 다음 인덱스 — 미완이면 null */
  private findStructureEnd(at: number): number | null {
    let depth = 0;
    let index = at;
    let inString = false;
    while (index < this.buffer.length) {
      const char = this.buffer[index];
      if (inString) {
        if (char === '\\') index += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '[' || char === '{') depth += 1;
      else if (char === ']' || char === '}') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    return null;
  }

  /** 공백을 건너뛴 첫 인덱스 — 남은 입력이 없으면 null */
  private skipSpace(): number | null {
    let index = this.cursor;
    while (index < this.buffer.length && /\s/.test(this.buffer[index])) index += 1;
    if (index >= this.buffer.length) {
      this.cursor = index;
      return null;
    }
    return index;
  }

  /**
   * 판정 필드를 담는다. 모델이 불리언을 문자열로 내는 것은 리랭커에서 이미 실측됐으므로
   * (docs/specs/29) 그 정도는 관대하게 받는다 — **판정 자체가 서지 않을 때만** 실패다.
   */
  private assign(key: string, value: unknown): void {
    if (key === FLAG_KEY) {
      if (typeof value === 'boolean') this.flag = value;
      else if (value === 'true') this.flag = true;
      else if (value === 'false') this.flag = false;
      else throw malformed();
      return;
    }
    if (key === ASPECTS_KEY) {
      this.aspectsSeen = true;
      this.aspects = Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
    }
  }
}

function malformed(): LlmProviderError {
  return new LlmProviderError('구조화 답변을 해석하지 못했습니다', { retryable: true });
}
