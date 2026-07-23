import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../../src/app.module';
import { buildOpenApiDocument } from '../../src/global/openapi/openapi-document.factory';

const SPEC_PATH = join(__dirname, '..', '..', 'openapi', 'cure-agent.v1.json');

/**
 * 계약 동기화 검증 (architecture.md §1, §13).
 * 커밋된 openapi/cure-agent.v1.json이 현재 코드의 재생성본과 다르면 실패한다.
 * 실패 시: pnpm openapi:export 실행 후 함께 커밋할 것.
 */
describe('contract: OpenAPI 스펙 동기화', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('커밋된 스펙 = 코드 재생성본 (diff = 0)', () => {
    expect(existsSync(SPEC_PATH)).toBe(true);

    const committed = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
    const regenerated = JSON.parse(JSON.stringify(buildOpenApiDocument(app)));
    expect(committed).toEqual(regenerated);
  });

  it('스펙 기본 계약: /api/v1 prefix + 쿠키 인증 스키마', () => {
    const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
    const paths = Object.keys(spec.paths);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith('/api/v1/')).toBe(true);
    }
    expect(spec.components.securitySchemes.cookie.in).toBe('cookie');
    expect(spec.components.securitySchemes.cookie.name).toBe('access_token');
  });
});
