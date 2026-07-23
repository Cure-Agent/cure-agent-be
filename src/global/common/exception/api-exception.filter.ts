import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { TraceContext } from '../../context/trace-context.service';
import { IgnorableExceptionClassifier } from '../../observability/ignorable-exception.classifier';
import { RealTimeAlertSender } from '../../observability/real-time-alert.sender';
import { ApiResponseDto } from '../response/api-response.dto';
import { ErrorCode } from './error-code.registry';
import { ServiceException } from './service.exception';

/**
 * 모든 예외를 에러코드 레지스트리 기반 봉투로 수렴시킨다 (architecture.md §10.2).
 * - ServiceException → 레지스트리의 status/message
 * - 프레임워크 HttpException(미지정 라우트 404 등) → 공통 코드로 매핑
 * - 그 외 → INTERNAL_ERROR(500) + 실시간 알림
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  private static readonly STATUS_TO_CODE: Record<number, ErrorCode> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    422: 'VALIDATION_FAILED',
  };

  constructor(
    private readonly traceContext: TraceContext,
    private readonly alertSender: RealTimeAlertSender,
    private readonly ignorableClassifier: IgnorableExceptionClassifier,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const traceId = this.traceContext.traceId;

    const { status, envelope } = this.toEnvelope(exception);
    envelope.traceId = traceId;

    if (status >= 500) {
      const error = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`[${traceId}] ${error.message}`, error.stack);
      if (!this.ignorableClassifier.isIgnorable(error)) {
        this.alertSender.send({ title: envelope.code, detail: error.message, traceId });
      }
    }

    if (res.headersSent) return; // 스트리밍 중 예외는 스트림 계약(§8 error 이벤트)이 담당
    res.setHeader('X-Trace-Id', traceId);
    res.status(status).json(envelope);
  }

  private toEnvelope(exception: unknown): { status: number; envelope: ApiResponseDto<unknown> } {
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

    return { status: 500, envelope: ApiResponseDto.failure('INTERNAL_ERROR') };
  }
}
