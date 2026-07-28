/**
 * 지침 원본 수집 CLI (docs/specs/18).
 * 사용법: DATABASE_URL 등 env 설정 후
 *   pnpm acquire:nckm [--limit N] [--guide-idx 325,326] [--out DIR]
 *
 * 원본 PDF는 --out 디렉토리(기본 .cure-data/)에 쓰고 DB에는 경로를 남기지 않는다 —
 * 재다운로드 가능하므로 해시만 추적한다.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import {
  AcquireOptions,
  GuidelineAcquisitionService,
} from '../src/domain/guideline/service/guideline-acquisition.service';

const DEFAULT_OUT_DIR = '.cure-data';

export function parseArgs(argv: string[]): AcquireOptions {
  const options: AcquireOptions = { outDir: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inlineValue] = argv[i].split('=', 2);
    const value = inlineValue ?? argv[i + 1];
    if (flag === '--limit') {
      options.limit = Number(value);
      if (inlineValue === undefined) i += 1;
    } else if (flag === '--guide-idx') {
      options.externalIds = String(value)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      if (inlineValue === undefined) i += 1;
    } else if (flag === '--out') {
      options.outDir = String(value);
      if (inlineValue === undefined) i += 1;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const result = await app.get(GuidelineAcquisitionService).acquire(options);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  void main();
}
