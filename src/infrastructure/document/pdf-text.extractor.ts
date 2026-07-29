/**
 * PDF 텍스트 추출 (docs/specs/19) — `unpdf`(pdfjs) 얇은 래퍼.
 *
 * `PdfTextExtractor`는 §3의 포트 기준("이걸 감싸지 않으면 수용 기준을 테스트로 동결할 수 없는가")을
 * 만족해 주입 가능한 클래스로 둔다 — docs/specs/21의 파이프라인 수용 기준은 파싱 입력(페이지 텍스트)을
 * 제어해야 검증되는데, 한글 CID 폰트를 심은 실 PDF를 테스트에서 합성하는 것은 현실적이지 않다.
 * 인터페이스는 만들지 않는다: 구현이 하나뿐이고 e2e는 `overrideProvider`로 치환하면 충분하다.
 */
import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { extractText, getDocumentProxy } from 'unpdf';

@Injectable()
export class PdfTextExtractor {
  /**
   * PDF를 페이지별 평문으로 추출한다 (물리 페이지 순서).
   *
   * @param source 파일 경로(CLI) 또는 본문 버퍼(파이프라인 — 디스크에 쓰지 않는다)
   */
  async extractPages(source: string | Uint8Array): Promise<string[]> {
    const bytes =
      typeof source === 'string' ? new Uint8Array(await readFile(source)) : new Uint8Array(source);
    const document = await getDocumentProxy(bytes);
    const { text } = await extractText(document, { mergePages: false });
    return text;
  }
}

/** CLI용 단축 진입점 — Nest 컨텍스트 없이 쓰는 경로다. */
export function extractPdfPages(filePath: string): Promise<string[]> {
  return new PdfTextExtractor().extractPages(filePath);
}
