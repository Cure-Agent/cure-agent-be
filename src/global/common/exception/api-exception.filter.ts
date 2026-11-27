import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { TraceContext } from '../../context/trace-context.service';
import { IgnorableExceptionClassifier } from '../../observability/ignorable-exception.classifier';
import { RealTimeAlertSender } from '../../observability/real-time-alert.sender';
import { ApiResponseDto } from '../response/api-response.dto';
import { ErrorCode, ErrorCodes } from './error-code.registry';
import { ServiceException } from './service.exception';

/** 우리 에러 모델 밖에서 온 4xx — 봉투에는 공통 코드만 실리므로 원래 사유는 로그로 남긴다 */
interface ForeignClientError {
  status: number;
  message: string;
}

/**
 * 모든 예외를 에러코드 레지스트리 기반 봉투로 수렴시킨다 (architecture.md §10.2).
 * - ServiceException → 레지스트리의 status/message
 * - 프레임워크 HttpException(미지정 라우트 404 등) → 공통 코드로 매핑
 * - 그 밖의 4xx(매핑 없는 HttpException, 본문 파서 같은 Express 미들웨어의 http-errors)
 *   → 매핑된 공통 코드, 없으면 BAD_REQUEST. 클라이언트 잘못이라 알림 없이 warn 로그만 남긴다
 * - 그 외 → INTERNAL_ERROR(500) + 실시간 알림
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  private static readonly STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    422: 'VALIDATION_FAILED',
    429: 'RATE_LIMITED',
  };

  constructor(
    private readonly traceContext: TraceContext,
    private readonly alertSender: RealTimeAlertSender,
    private readonly ignorableClassifier: IgnorableExceptionClassifier,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const traceId = this.traceContext.traceId;

    const { status, envelope, foreign } = this.toEnvelope(exception);
    envelope.traceId = traceId;

    if (status >= 500) {
      const error = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`[${traceId}] ${error.message}`, error.stack);
      if (!this.ignorableClassifier.isIgnorable(error)) {
        this.alertSender.send({ title: envelope.code, detail: error.message, traceId });
      }
    } else if (foreign) {
      this.logger.warn(`[${traceId}] 요청 거부(${foreign.status}): ${foreign.message}`);
    }

    if (res.headersSent) return; // 스트리밍 중 예외는 스트림 계약(§8 error 이벤트)이 담당
    res.setHeader('X-Trace-Id', traceId);
    res.status(status).json(envelope);
  }

  private toEnvelope(exception: unknown): {
    status: number;
    envelope: ApiResponseDto<unknown>;
    foreign?: ForeignClientError;
  } {
    if (exception instanceof ServiceException) {
      return {
        status: exception.status,
        envelope: ApiResponseDto.failure(exception.code, exception.data),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = ApiExceptionFilter.STATUS_TO_CODE[status];
      if (code) return { status, envelope: ApiResponseDto.failure(code) };
    }

    const foreign = foreignClientError(exception);
    if (foreign) {
      const code = ApiExceptionFilter.STATUS_TO_CODE[foreign.status] ?? 'BAD_REQUEST';
      return { status: ErrorCodes[code].status, envelope: ApiResponseDto.failure(code), foreign };
    }

    return { status: 500, envelope: ApiResponseDto.failure('INTERNAL_ERROR') };
  }
}

/**
 * 클라이언트 잘못(4xx)이 확실한데 위에서 코드가 정해지지 않은 예외.
 * - 매핑 없는 HttpException(413·415 등)
 * - http-errors 객체 — 본문 파서(body-parser)처럼 라우팅 전에 도는 Express 미들웨어가 던진다.
 *   Nest는 이 가운데 SyntaxError·URIError만 BadRequestException으로 바꾸고 나머지는 그대로 넘긴다
 *   (`RoutesResolver.mapExternalException`). 그래서 압축 해제 실패·지원하지 않는 Content-Encoding이
 *   500 + 알림으로 나갔다 (#563). 100KB 초과 본문·지원하지 않는 charset도 같은 경로다.
 *
 * http-errors 판정은 그 패키지의 `isHttpError`와 같은 모양 검사다(Error + boolean expose + statusCode === status).
 * status만 보면 안 된다 — 상류 응답 status를 실은 예외는 우리 장애라 500 + 알림으로 남아야 한다.
 * 현재 상류 오류 클래스(LlmProviderError 등)는 status를 `options` 안에 두므로 여기에 걸리지 않는다.
 */
function foreignClientError(exception: unknown): ForeignClientError | undefined {
  if (!(exception instanceof Error)) return undefined;

  const status =
    exception instanceof HttpException ? exception.getStatus() : httpErrorStatus(exception);
  if (status === undefined || status < 400 || status >= 500) return undefined;

  return { status, message: exception.message };
}

function httpErrorStatus(error: Error): number | undefined {
  const { expose, status, statusCode } = error as Error & {
    expose?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  if (typeof expose !== 'boolean' || typeof statusCode !== 'number' || status !== statusCode) {
    return undefined;
  }
  return statusCode;
}
