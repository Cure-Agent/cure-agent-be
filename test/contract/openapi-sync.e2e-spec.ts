import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { buildOpenApiDocument } from '../../src/global/openapi/openapi-document.factory';
import { bootstrapApp } from '../fixtures/app-bootstrap';

const SPEC_PATH = join(__dirname, '..', '..', 'openapi', 'cure-agent.v1.json');

const AGENT_STREAM_PATH = '/api/v1/agent/conversations/{conversationId}/messages/stream';

function requireObject(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`커밋된 OpenAPI의 ${location}가 객체가 아니다`);
  }
  return value as Record<string, unknown>;
}

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
    await bootstrapApp(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('docs/specs/51 기준 117: 비어 있지 않은 공개 계약에 내부 경로가 없다', () => {
    const spec: unknown = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec) || !('paths' in spec)) {
      throw new Error('커밋된 OpenAPI 문서에 paths가 없다');
    }
    const paths: unknown = spec.paths;
    if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) {
      throw new Error('커밋된 OpenAPI의 paths가 객체가 아니다');
    }

    const pathKeys = Object.keys(paths);
    expect(pathKeys.length).toBeGreaterThan(0);
    expect(pathKeys.filter((path) => path.startsWith('/api/v1/internal/'))).toEqual([]);
  });

  it('docs/specs/52 기준 1: 커밋된 공개 계약에 에이전트 스트림 POST가 있다', () => {
    const spec: unknown = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
    const document = requireObject(spec, '문서');
    const paths = requireObject(document.paths, 'paths');

    expect(paths).toHaveProperty([AGENT_STREAM_PATH]);
    const path = requireObject(paths[AGENT_STREAM_PATH], AGENT_STREAM_PATH);
    expect(path).toHaveProperty('post');
    requireObject(path.post, `${AGENT_STREAM_PATH}.post`);
  });

  it('docs/specs/52 기준 2: 요청 DTO 참조와 필수·선택 필드가 공개 계약에 있다', () => {
    const spec: unknown = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
    const document = requireObject(spec, '문서');
    const paths = requireObject(document.paths, 'paths');
    const path = requireObject(paths[AGENT_STREAM_PATH], AGENT_STREAM_PATH);
    const post = requireObject(path.post, `${AGENT_STREAM_PATH}.post`);
    const requestBody = requireObject(post.requestBody, 'post.requestBody');
    const content = requireObject(requestBody.content, 'post.requestBody.content');
    const json = requireObject(content['application/json'], 'requestBody의 application/json');
    const schema = requireObject(json.schema, 'requestBody의 JSON schema');

    expect(schema.$ref).toBe('#/components/schemas/AcceptAgentTurnRequestDto');

    const components = requireObject(document.components, 'components');
    const schemas = requireObject(components.schemas, 'components.schemas');
    expect(schemas).toHaveProperty('AcceptAgentTurnRequestDto');
    const dto = requireObject(schemas.AcceptAgentTurnRequestDto, 'AcceptAgentTurnRequestDto');
    const properties = requireObject(dto.properties, 'AcceptAgentTurnRequestDto.properties');
    expect(properties).toHaveProperty('content');
    expect(properties).toHaveProperty('clientRequestId');
    expect(properties).toHaveProperty('responseLang');

    const required: unknown = dto.required;
    if (!Array.isArray(required)) {
      throw new Error('AcceptAgentTurnRequestDto.required가 배열이 아니다');
    }
    expect(required).toContain('content');
    expect(required).toContain('clientRequestId');
    expect(required).not.toContain('responseLang');
  });

  it('docs/specs/52 기준 3: 에이전트 스트림 응답에 401·409·422·502가 각각 있다', () => {
    const spec: unknown = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
    const document = requireObject(spec, '문서');
    const paths = requireObject(document.paths, 'paths');
    const path = requireObject(paths[AGENT_STREAM_PATH], AGENT_STREAM_PATH);
    const post = requireObject(path.post, `${AGENT_STREAM_PATH}.post`);
    const responses = requireObject(post.responses, 'post.responses');

    expect(responses).toHaveProperty('401');
    expect(responses).toHaveProperty('409');
    expect(responses).toHaveProperty('422');
    expect(responses).toHaveProperty('502');
  });

  it('docs/specs/52 기준 4: 비어 있지 않은 공개 계약에 내부 경로가 여전히 없다', () => {
    const spec: unknown = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
    const document = requireObject(spec, '문서');
    const paths = requireObject(document.paths, 'paths');
    const pathKeys = Object.keys(paths);

    expect(pathKeys.length).toBeGreaterThan(0);
    expect(pathKeys.filter((path) => path.startsWith('/api/v1/internal/'))).toEqual([]);
  });

  it('docs/specs/52 기준 5: 정상 응답하는 BE 앱은 에이전트 스트림에 404 봉투를 반환한다', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);

    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/conversations/conv-901/messages/stream')
      .set('X-CSRF-Protection', '1')
      .send({
        content: '합성 테스트 질문입니다.',
        clientRequestId: 'spec-52-request-901',
      })
      .expect(404);

    const body: unknown = response.body;
    expect(body).toMatchObject({ success: false, code: 'NOT_FOUND' });
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
