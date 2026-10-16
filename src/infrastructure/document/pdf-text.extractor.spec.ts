// pdf-text.extractor 회귀 테스트 (docs/specs/19 「어절 경계 줄바꿈」, #535)
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const RESULT_MARKER = '@@pdf-text.extractor.spec@@';

/**
 * 추출기를 **별도 node 프로세스**에서 돌린다.
 *
 * jest의 vm은 unpdf CJS 진입점의 `import("unpdf/pdfjs")`를 막고
 * (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG` — `--experimental-vm-modules` 없이는 동적 import 불가),
 * `module.createRequire`까지 jest 자신의 require로 바꿔 끼워 ESM 번들을 돌아 들여올 길도 없다.
 * 전역 jest 설정을 바꾸는 대신 이 테스트만 운영과 같은 경로(ts-node로 읽은 추출기 + 패치된 unpdf)로
 * 실행한다. pdfjs가 경고를 stdout에 찍으므로 결과는 표지 뒤에 싣는다.
 */
function extractInChildProcess(pdfs: Uint8Array[]): string[][] {
  const script = [
    `const { PdfTextExtractor } = require(${JSON.stringify(resolve(__dirname, 'pdf-text.extractor.ts'))});`,
    "const inputs = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));",
    '(async () => {',
    '  const extractor = new PdfTextExtractor();',
    '  const results = [];',
    "  for (const input of inputs) results.push(await extractor.extractPages(Buffer.from(input, 'base64')));",
    `  process.stdout.write(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(results));`,
    '})().catch((error) => { console.error(error); process.exit(1); });',
  ].join('\n');
  const stdout = execFileSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-e', script],
    {
      cwd: REPO_ROOT,
      input: JSON.stringify(pdfs.map((pdf) => Buffer.from(pdf).toString('base64'))),
      encoding: 'utf8',
    },
  );
  return JSON.parse(stdout.slice(stdout.lastIndexOf(RESULT_MARKER) + RESULT_MARKER.length));
}

/**
 * 표준 폰트(Helvetica)만 쓰는 최소 PDF를 만든다 — 페이지마다 콘텐츠 스트림 하나.
 * xref 오프셋까지 맞춘다(pdfjs가 깨진 xref를 재구성하는 경로에 기대지 않기 위해서다).
 */
function buildPdf(pageStreams: string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds = pageStreams.map((_, index) => 4 + index * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pageStreams.forEach((stream, index) => {
    const pageId = pageIds[index];
    objects[pageId] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  // ASCII만 쓰므로 문자 수가 곧 바이트 오프셋이다
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
}

/** 한 줄씩 아래로 내려가며 문자열을 찍는 콘텐츠 스트림 */
const textLines = (...lines: string[]): string =>
  [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    ...lines.map((line, index) => `${index === 0 ? '' : '0 -14 Td '}(${line}) Tj`),
    'ET',
  ].join('\n');

describe('PdfTextExtractor', () => {
  let trailingSpacePages: string[];
  let twoPages: string[];

  beforeAll(() => {
    [trailingSpacePages, twoPages] = extractInChildProcess([
      buildPdf([textLines('hello ', 'world')]),
      buildPdf([textLines('first page'), textLines('second page')]),
    ]);
  }, 60_000);

  it('줄 끝 공백 글리프를 지우지 않는다 — 청커의 어절 경계 판정 근거다 (unpdf keepWhiteSpace 패치)', () => {
    // 패치가 빠지면 pdfjs가 공백 글리프를 버려 'hello\nworld'가 된다
    expect(trailingSpacePages).toEqual(['hello \nworld']);
  });

  it('페이지를 물리 순서대로 한 문자열씩 돌려준다', () => {
    expect(twoPages).toEqual(['first page', 'second page']);
  });
});
