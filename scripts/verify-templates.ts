/**
 * 실물 회귀 대조 CLI (docs/specs/20 수용 기준 13).
 * 사용법: pnpm verify:templates [--dir .cure-data/survey] [--update]
 *
 * 원문 PDF를 커밋하지 않으므로 CI에는 대상 디렉토리가 없다 — 없으면 **스킵하고 0으로 종료**한다.
 * `--update`는 현재 산출을 기대치 파일에 다시 쓴다(개선을 반영할 때만 의도적으로 쓴다).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chunkNckmGuidelineWithDiagnostics,
  GuidelineDocumentMeta,
} from '../src/infrastructure/document/guideline-chunker';
import { extractPdfPages } from '../src/infrastructure/document/pdf-text.extractor';
import {
  compareToExpectations,
  TemplateActual,
  TemplateExpectation,
} from '../src/infrastructure/document/template-verification';

const DEFAULT_DIR = '.cure-data/survey';
const EXPECTATIONS_PATH = 'test/fixtures/nckm-template-expectations.json';

/** 진단만 뽑는 용도라 문서 메타는 의미가 없다 — 계약 검증을 통과할 최소값을 쓴다 */
const PLACEHOLDER_META: GuidelineDocumentMeta = {
  title: 'verify',
  publisher: 'verify',
  version: 'verify',
  publishedAt: '2026-01-01',
  sourceUrl: 'https://example.invalid/verify',
};

export interface VerifyArgs {
  dir: string;
  update: boolean;
}

export function parseArgs(argv: string[]): VerifyArgs {
  const args: VerifyArgs = { dir: DEFAULT_DIR, update: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inlineValue] = argv[i].split('=', 2);
    if (flag === '--dir') {
      args.dir = String(inlineValue ?? argv[i + 1]);
      if (inlineValue === undefined) i += 1;
    } else if (flag === '--update') {
      args.update = true;
    }
  }
  return args;
}

async function collectActual(dir: string): Promise<Record<string, TemplateActual>> {
  const actual: Record<string, TemplateActual> = {};
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.pdf')).sort()) {
    const documentId = file.replace(/\.pdf$/, '');
    const pages = await extractPdfPages(join(dir, file));
    const { input, diagnostics } = chunkNckmGuidelineWithDiagnostics(pages, PLACEHOLDER_META);
    const recommendations = input.sections
      .flatMap((section) => section.chunks)
      .filter((chunk) => chunk.recommendationGrade !== undefined).length;
    actual[documentId] = { diagnostics, recommendations };
  }
  return actual;
}

function toExpectations(actual: Record<string, TemplateActual>): Record<string, TemplateExpectation> {
  const expectations: Record<string, TemplateExpectation> = {};
  for (const [documentId, observed] of Object.entries(actual)) {
    const unparsed = [
      ...new Set([
        ...observed.diagnostics.missing,
        ...observed.diagnostics.duplicated,
        ...observed.diagnostics.gradeMissing,
      ]),
    ].sort();
    expectations[documentId] = {
      uniqueNumbers: observed.diagnostics.uniqueNumbers.length,
      recommendations: observed.recommendations,
      status: unparsed.length === 0 ? 'OK' : 'PARTIAL',
      ...(unparsed.length > 0 ? { unparsed } : {}),
    };
  }
  return expectations;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dir)) {
    console.log(`${args.dir} 없음 — 실물 회귀 검사를 건너뜁니다 (CI에는 원문 PDF가 없습니다).`);
    return;
  }

  const actual = await collectActual(args.dir);
  if (args.update) {
    writeFileSync(EXPECTATIONS_PATH, `${JSON.stringify(toExpectations(actual), null, 2)}\n`);
    console.log(`${EXPECTATIONS_PATH} 갱신 — 문서 ${Object.keys(actual).length}건`);
    return;
  }

  const expected = JSON.parse(readFileSync(EXPECTATIONS_PATH, 'utf8')) as Record<
    string,
    TemplateExpectation
  >;
  const report = compareToExpectations(actual, expected);
  console.log(
    `대조 ${report.checked}건 — OK ${report.ok} / PARTIAL ${report.partial} / 불일치 ${report.mismatches.length}`,
  );
  for (const { documentId, reason } of report.mismatches) {
    console.error(`  불일치 ${documentId}: ${reason}`);
  }
  for (const documentId of report.unexpected) {
    console.error(`  기대치에 없는 문서: ${documentId}`);
  }
  for (const documentId of report.missingDocuments) {
    console.error(`  디렉토리에 없는 문서: ${documentId}`);
  }
  if (report.mismatches.length + report.unexpected.length + report.missingDocuments.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
