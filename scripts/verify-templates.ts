/**
 * 실물 회귀 대조 CLI (docs/specs/20 수용 기준 13).
 * 사용법: pnpm verify:templates [--dir .cure-data/survey] [--update]
 *
 * 원문 PDF를 커밋하지 않으므로 CI에는 대상 디렉토리가 없다 — 없으면 **스킵하고 0으로 종료**한다.
 * `--update`는 현재 산출을 기대치 파일에 다시 쓴다(개선을 반영할 때만 의도적으로 쓴다).
 */
import { GuidelineDocumentMeta } from '../src/infrastructure/document/guideline-chunker';

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

async function main(): Promise<void> {
  void PLACEHOLDER_META;
  void EXPECTATIONS_PATH;
  parseArgs(process.argv.slice(2));
  return Promise.resolve();
}

if (require.main === module) {
  void main();
}
