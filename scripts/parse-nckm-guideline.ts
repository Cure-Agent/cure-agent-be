/**
 * 지침 PDF 파싱·청킹 CLI (docs/specs/19).
 * 사용법: DATABASE_URL 등 env 설정 후
 *   pnpm parse:nckm <pdf> --guide-idx 325 [--out out.json]
 *   [--title ..] [--publisher ..] [--version ..] [--published-at ..] [--source-url ..]
 *
 * 출력 JSON은 `pnpm ingest <json>`이 소비한다. 파싱과 적재를 한 명령으로 합치지 않는 이유는
 * 중간 산출물을 눈으로 검토하는 단계가 인용 정확도의 마지막 방어선이기 때문이다.
 */
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { AppModule } from '../src/app.module';
import { GuidelineParseService } from '../src/domain/guideline/service/guideline-parse.service';
import { GuidelineDocumentMeta } from '../src/infrastructure/document/guideline-chunker';
import { extractPdfPages } from '../src/infrastructure/document/pdf-text.extractor';

interface ParseArgs {
  pdfPath?: string;
  externalId?: string;
  outPath?: string;
  overrides: Partial<GuidelineDocumentMeta>;
}

const META_FLAGS: Record<string, keyof GuidelineDocumentMeta> = {
  '--title': 'title',
  '--publisher': 'publisher',
  '--version': 'version',
  '--published-at': 'publishedAt',
  '--source-url': 'sourceUrl',
};

export function parseArgs(argv: string[]): ParseArgs {
  const args: ParseArgs = { overrides: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inlineValue] = argv[i].split('=', 2);
    if (!flag.startsWith('--')) {
      args.pdfPath ??= argv[i];
      continue;
    }
    const value = inlineValue ?? argv[i + 1];
    if (inlineValue === undefined) i += 1;
    if (flag === '--guide-idx') {
      args.externalId = String(value);
    } else if (flag === '--out') {
      args.outPath = String(value);
    } else {
      const field = META_FLAGS[flag];
      if (field) args.overrides[field] = String(value);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pdfPath || !args.externalId) {
    console.error('사용법: pnpm parse:nckm <pdf> --guide-idx <idx> [--out <json>]');
    process.exit(1);
  }

  const pages = await extractPdfPages(args.pdfPath);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const input = await app.get(GuidelineParseService).parse({
      pages,
      externalId: args.externalId,
      overrides: args.overrides,
    });
    const json = JSON.stringify(input, null, 2);
    if (args.outPath) {
      writeFileSync(args.outPath, json);
      const chunks = input.sections.reduce((sum, section) => sum + section.chunks.length, 0);
      console.log(`${args.outPath} — 섹션 ${input.sections.length}개, 청크 ${chunks}개`);
    } else {
      console.log(json);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  void main();
}
