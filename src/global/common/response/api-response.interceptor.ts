import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { Observable, map } from 'rxjs';
import { TraceContext } from '../../context/trace-context.service';
import { ApiResponseDto } from './api-response.dto';
import { PageResult } from './page-result';

/**
 * 컨트롤러 반환값을 공통 봉투로 감싼다.
 * - ApiResponseDto를 직접 반환하면 그대로 사용 (성공 코드를 지정하고 싶은 경우)
 * - PageResult 반환 시 data+page 봉투로 변환
 * - SSE/스트리밍처럼 이미 응답이 전송된 경우는 손대지 않는다 (§10.1: SSE에 봉투 미적용)
 */
@Injectable()
export class ApiResponseInterceptor implements NestInterceptor {
  constructor(private readonly traceContext: TraceContext) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((body: unknown) => {
        const res = context.switchToHttp().getResponse<Response>();
        if (res.headersSent) return body;

        let envelope: ApiResponseDto<unknown>;
        if (body instanceof ApiResponseDto) {
          envelope = body;
        } else if (body instanceof PageResult) {
          envelope = ApiResponseDto.successPage(body);
        } else {
          envelope = ApiResponseDto.success(body ?? null);
        }

        envelope.traceId = this.traceContext.traceId;
        res.setHeader('X-Trace-Id', envelope.traceId);
        return envelope;
      }),
    );
  }
}
