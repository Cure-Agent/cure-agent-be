/**
 * PDF 텍스트 추출 (docs/specs/19) — `unpdf`(pdfjs) 얇은 래퍼.
 *
 * `PdfTextExtractor`는 §3의 포트 기준("이걸 감싸지 않으면 수용 기준을 테스트로 동결할 수 없는가")을
 * 만족해 주입 가능한 클래스로 둔다 — docs/specs/21의 파이프라인 수용 기준은 파싱 입력(페이지 텍스트)을
 * 제어해야 검증되는데, 한글 CID 폰트를 심은 실 PDF를 테스트에서 합성하는 것은 현실적이지 않다.
 * 인터페이스는 만들지 않는다: 구현이 하나뿐이고 e2e는 `overrideProvider`로 치환하면 충분하다.
 *
 * **페이지를 하나씩 추출한다.** unpdf의 `extractText`는 전 페이지를 `Promise.all`로 한꺼번에 띄워
 * 모든 페이지의 파싱 상태를 동시에 들고 있었다. 한 페이지씩 추출하고 `page.cleanup()`으로 놓으면
 * 그 상태가 페이지 단위로 풀린다 — 로컬 최대 RSS(MiB, #174/#232/#153)가 564/518/380에서
 * 434/451/172로 내려갔다. 문서는 끝나면 반드시 닫는다(`extractText`는 넘겨받은 문서를 닫지 않았다).
 *
 * **줄 끝 공백을 지우지 않는다.** 양쪽 정렬 지침 PDF는 줄바꿈 자리의 어절 경계에 공백 글리프를
 * 갖고 있고(비만 325 Ⅳ장 한글–한글 줄 경계 2,796곳 중 876곳), 청커가 그 공백으로 어절 경계를
 * 판정한다(guideline-chunker `appendWrapped`). pdfjs는 공개 API에서 공백 글리프를 버리므로 unpdf
 * 번들에 `keepWhiteSpace` 패치를 건다(patches/unpdf@1.8.0.patch). 패치가 빠지면
 * pdf-text.extractor.spec이 실패한다 — unpdf를 올릴 때 패치를 다시 만들어야 한다.
 */
import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { getDocumentProxy } from 'unpdf';

@Injectable()
export class PdfTextExtractor {
  /**
   * PDF를 페이지별 평문으로 추출한다 (물리 페이지 순서).
   *
   * 페이지 텍스트 형식은 unpdf `extractText`와 같다 — 텍스트 항목을 잇고 줄 끝(`hasEOL`)마다 `\n`.
   *
   * @param source 파일 경로(CLI) 또는 본문 버퍼(파이프라인 — 디스크에 쓰지 않는다)
   */
  async extractPages(source: string | Uint8Array): Promise<string[]> {
    // 언제나 복사본을 넘긴다 — pdfjs가 받은 버퍼를 워커로 transfer해 원본을 detach한다
    const bytes =
      typeof source === 'string' ? new Uint8Array(await readFile(source)) : new Uint8Array(source);
    const document = await getDocumentProxy(bytes);
    try {
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const { items } = await page.getTextContent();
        pages.push(
          items
            .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : ''))
            .join(''),
        );
        page.cleanup();
      }
      return pages;
    } finally {
      await document.loadingTask.destroy();
    }
  }
}

/** CLI용 단축 진입점 — Nest 컨텍스트 없이 쓰는 경로다. */
export function extractPdfPages(filePath: string): Promise<string[]> {
  return new PdfTextExtractor().extractPages(filePath);
}
