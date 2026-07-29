import { PdfTextExtractor } from '../../src/infrastructure/document/pdf-text.extractor';
import { nckmSamplePages } from './nckm-pages.sample';

/** 추출 호출 1회의 관찰 기록 */
export interface PdfExtractCall {
  /**
   * 버퍼로 받았는가. 파이프라인은 PDF를 디스크에 쓰지 않고 본문 버퍼를 그대로 넘겨야 하므로
   * (docs/specs/22 「PDF도 §21과 같이 디스크에 쓰지 않는다」) 이 값이 false면 수용 기준 3이 깨진 것이다.
   * `fs/promises` 목킹이 직접 증거이고 이 기록은 보조 관찰이다 — 경로를 받았다는 사실 자체가
   * 어딘가에 파일이 있었다는 뜻이다.
   */
  buffered: boolean;
  /** 버퍼면 바이트 수, 경로면 null */
  bytes: number | null;
  /** 경로면 그 문자열, 버퍼면 utf8로 읽은 본문 — 어느 문서였는지 식별하는 축이다 */
  text: string;
}

/**
 * `PdfTextExtractor` 대체 fixture (docs/specs/22).
 *
 * spec 21의 e2e는 모듈 스코프 변수 하나로 「이번 호출이 낼 페이지」를 갈아끼웠지만, 전건 잡은
 * 한 번의 요청으로 여러 문서를 순서대로 파싱하므로 호출 사이에 테스트가 끼어들 자리가 없다.
 * 그래서 **본문에 심어둔 마커별 페이지 매핑**을 미리 등록해 두고, 호출 시점의 버퍼 내용으로 고른다
 * (추출기는 externalId를 받지 않는다 — 받는 것은 버퍼뿐이다).
 */
export class FakePdfExtractor implements PdfTextExtractor {
  /** 호출 순서대로 쌓이는 관찰 기록 */
  readonly calls: PdfExtractCall[] = [];

  private defaultPages: string[] = [...nckmSamplePages];
  private readonly byMarker = new Map<string, string[]>();

  /**
   * 마커가 본문에 들어 있는 문서가 낼 페이지.
   * @param marker 다운로드 본문에 심어둔 문자열 (보통 externalId)
   */
  setPagesFor(marker: string, pages: string[]): this {
    this.byMarker.set(marker, [...pages]);
    return this;
  }

  /** 어떤 마커에도 걸리지 않은 문서가 낼 페이지 — 전건 잡의 「나머지 정상 문서」가 여기로 온다 */
  setDefaultPages(pages: string[]): this {
    this.defaultPages = [...pages];
    return this;
  }

  reset(): this {
    this.calls.length = 0;
    this.byMarker.clear();
    this.defaultPages = [...nckmSamplePages];
    return this;
  }

  /** 모든 호출이 버퍼로 들어왔는가 (수용 기준 3의 보조 관찰) */
  get allBuffered(): boolean {
    return this.calls.every((call) => call.buffered);
  }

  extractPages(source: string | Uint8Array): Promise<string[]> {
    const buffered = typeof source !== 'string';
    const text = buffered ? Buffer.from(source).toString('utf8') : source;
    this.calls.push({ buffered, bytes: buffered ? source.byteLength : null, text });

    // 등록 순서가 아니라 "본문에 있는 마커"로 고른다 — 잡이 문서를 어떤 순서로 처리하든 결과가 같다
    for (const [marker, pages] of this.byMarker) {
      if (text.includes(marker)) return Promise.resolve(pages.map((page) => page));
    }
    return Promise.resolve(this.defaultPages.map((page) => page));
  }
}
