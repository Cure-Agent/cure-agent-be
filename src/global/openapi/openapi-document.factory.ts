import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule, getSchemaPath } from '@nestjs/swagger';
import { AcceptAgentTurnRequestDto } from '../../domain/agent-turn/dto/request/accept-agent-turn.request.dto';
import { ErrorCodes } from '../common/exception/error-code.registry';
import { ApiResponseDto } from '../common/response/api-response.dto';
import { ACCESS_COOKIE } from '../security/token-resolver';

export const OPENAPI_VERSION = '1.0.0';

/**
 * 브라우저가 부르는 에이전트 스트림 엔드포인트 (docs/specs/52 · architecture.md §8 「에이전트 스트림」).
 *
 * **BE가 서빙하지 않는 문서 전용 경로다.** 운영 nginx가 같은 오리진에서 `/api/v1/agent/`를
 * 에이전트(`agent:8000`)로 보내므로 FE에게는 한 API이고, 이 문서에서 생성된 타입으로 본문을 조립한다
 * (§1 「OpenAPI가 두 레포 사이의 공식 계약」). BE 앱에 이 경로를 요청하면 404다 — 컨트롤러가 없다.
 * 요청 모델은 내부 수락 API의 `AcceptAgentTurnRequestDto`와 같은 모양이며, 에이전트 pydantic 모델과의
 * 동기화는 사람이 지킨다(spec 52 Out of scope).
 */
export const AGENT_STREAM_PATH = '/api/v1/agent/conversations/{conversationId}/messages/stream';

function envelopeErrorResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          allOf: [
            { $ref: getSchemaPath(ApiResponseDto) },
            { properties: { data: { nullable: true } } },
          ],
        },
      },
    },
  };
}

function buildAgentStreamPathItem(): Record<string, unknown> {
  return {
    post: {
      operationId: 'AgentStream_streamMessage',
      summary: '일반 대화(GUIDELINE_QA) 질문 전송 + SSE 스트리밍 답변 — 에이전트가 서빙 (문서 전용 경로)',
      description:
        '**BE가 서빙하지 않는다** — nginx가 같은 오리진에서 이 경로를 에이전트 서비스로 보낸다. ' +
        'GUIDELINE_QA 대화의 전송은 이 경로로, PATIENT_GUIDANCE 대화는 ' +
        '`POST /conversations/{conversationId}/messages/stream` 그대로다. ' +
        '이벤트 계약은 채팅 스트림과 같고 **agent.progress**(stage)가 더해진다 — ' +
        '단계는 stage 필드로 쪼개며 모르는 stage·모르는 route는 무시한다(진행 이벤트는 상태를 만들지 않는다). ' +
        '공통: message.accepted → agent.progress(stage=routed, route=GUIDELINE|PATIENT|COMPOSITE|OTHER). ' +
        '지침(GUIDELINE): retrieval.started → retrieval.progress(stage) → answer.started → ' +
        'retrieval.evidence × N → retrieval.completed → answer.delta(seq) → answer.completed | answer.abstained | error. ' +
        '환자(PATIENT): agent.progress(stage=patient_loaded) → answer.delta × N → answer.completed. ' +
        '복합(COMPOSITE): agent.progress(stage=patient_loaded) → retrieval.* (answer.started는 evidenceCount를 싣는다) → ' +
        'retrieval.evidence × N → retrieval.completed → answer.delta × N → answer.completed | answer.abstained. ' +
        '기타(OTHER): answer.abstained(out_of_scope) — 환자·복합의 라벨 해석 실패는 answer.abstained(patient_unresolved). ' +
        '스트림 전 실패는 SSE가 아니라 공통 응답 봉투다: 401 AUTH_TOKEN_EXPIRED(선검사 — FE는 refresh 뒤 1회 재시도) · ' +
        '404 NOT_FOUND(대화 없음·타 클리닉) · 409 DUPLICATE_CLIENT_REQUEST · 422 VALIDATION_FAILED · ' +
        '502 AGENT_BACKEND_UNAVAILABLE(에이전트가 BE에 닿지 못함 — retryable). 15초 heartbeat 주석 전송.',
      tags: ['Agent'],
      parameters: [
        { name: 'conversationId', required: true, in: 'path', schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: getSchemaPath(AcceptAgentTurnRequestDto) } },
        },
      },
      responses: {
        '200': {
          description: 'SSE 이벤트 스트림 (architecture.md §8 에이전트 스트림)',
          content: { 'text/event-stream': { schema: { type: 'string' } } },
        },
        '401': envelopeErrorResponse(
          `AUTH_TOKEN_EXPIRED — ${ErrorCodes.AUTH_TOKEN_EXPIRED.message} (스트림 전 선검사)`,
        ),
        '404': envelopeErrorResponse(`NOT_FOUND — ${ErrorCodes.NOT_FOUND.message}`),
        '409': envelopeErrorResponse(
          `DUPLICATE_CLIENT_REQUEST — ${ErrorCodes.DUPLICATE_CLIENT_REQUEST.message}`,
        ),
        '422': envelopeErrorResponse(`VALIDATION_FAILED — ${ErrorCodes.VALIDATION_FAILED.message}`),
        '502': envelopeErrorResponse(
          `AGENT_BACKEND_UNAVAILABLE — ${ErrorCodes.AGENT_BACKEND_UNAVAILABLE.message}`,
        ),
      },
    },
  };
}

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
        '일반 JSON 응답은 공통 응답 형식(success/code/message/data/page/timestamp/traceId)을 사용하며, ' +
        'SSE 스트리밍은 별도의 이벤트 스키마를 따른다. 인증은 HttpOnly 쿠키 기반이다. ' +
        '`/api/v1/agent/` 경로는 BE가 아니라 에이전트 서비스가 서빙한다(문서 전용 — docs/specs/52).',
    )
    .setVersion(OPENAPI_VERSION)
    .addCookieAuth(ACCESS_COOKIE)
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    // 문서 전용 경로의 요청 스키마 — 컨트롤러가 없어 스캔으로는 components에 오르지 않는다.
    extraModels: [AcceptAgentTurnRequestDto, ApiResponseDto],
  });

  document.paths[AGENT_STREAM_PATH] = buildAgentStreamPathItem() as OpenAPIObject['paths'][string];
  return document;
}
