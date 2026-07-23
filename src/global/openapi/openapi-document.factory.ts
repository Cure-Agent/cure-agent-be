import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { ACCESS_COOKIE } from '../security/token-resolver';

export const OPENAPI_VERSION = '1.0.0';

/**
 * OpenAPI 문서 생성 단일 지점 (architecture.md §1).
 * 런타임 Swagger UI와 scripts/export-openapi.ts가 같은 문서를 사용한다 —
 * 두 경로가 갈라지면 contract 테스트(diff=0)가 무의미해진다.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Cure Agent API')
    .setDescription(
      '한의 임상 지침 기반 어시스턴트 API. ' +
        '일반 JSON 응답은 공통 봉투(success/code/message/data/page/timestamp/traceId)를 사용하며, ' +
        'SSE 스트리밍에는 봉투를 적용하지 않는다. 인증은 HttpOnly 쿠키 기반이다.',
    )
    .setVersion(OPENAPI_VERSION)
    .addCookieAuth(ACCESS_COOKIE)
    .build();

  return SwaggerModule.createDocument(app, config);
}
