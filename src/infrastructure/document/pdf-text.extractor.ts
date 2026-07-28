/**
 * PDF 텍스트 추출 (docs/specs/19) — `unpdf`(pdfjs) 얇은 래퍼.
 *
 * 외부 HTTP가 아니라 로컬 라이브러리이므로 §3 포트 기준에 해당하지 않는다.
 * 라이브러리 동작 재검증은 Out of scope — 검증은 골든 텍스트로 CLI를 수동 실행해 수행한다.
 */
import { readFile } from 'node:fs/promises';
import { extractText, getDocumentProxy } from 'unpdf';

/** PDF 파일을 페이지별 평문으로 추출한다 (물리 페이지 순서). */
export async function extractPdfPages(filePath: string): Promise<string[]> {
  const file = await readFile(filePath);
  const document = await getDocumentProxy(new Uint8Array(file));
  const { text } = await extractText(document, { mergePages: false });
  return text;
}
