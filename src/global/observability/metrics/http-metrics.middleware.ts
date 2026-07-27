/**
 * HTTP RED 지표 수집 (docs/specs/12 §운영 관측).
 *
 * 인터셉터가 아니라 미들웨어인 이유: 최종 상태코드는 ApiExceptionFilter가 예외를 봉투로
 * 변환한 뒤에야 정해진다. 응답 종료 이벤트에서 읽어야 5xx가 200으로 집계되지 않는다.
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    let recorded = false;

    // finish=정상 종료, close=클라이언트 중단(SSE abort 등). 둘 다 올 수 있어 1회로 막는다
    const record = (): void => {
      if (recorded) return;
      recorded = true;
      const durationSec = Number(process.hrtime.bigint() - startedAt) / 1e9;
      this.metrics.recordHttpRequest(req.method, routeOf(req), res.statusCode, durationSec);
    };

    res.once('finish', record);
    res.once('close', record);

    next();
  }
}

/**
 * 매칭된 라우트 패턴만 라벨로 쓴다 — 원본 URL을 쓰면 경로 파라미터(ULID)마다
 * 시계열이 생겨 카디널리티가 폭발한다. 미매칭 요청(404·스캐너)은 한 버킷으로 모은다.
 */
function routeOf(req: Request): string {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof path !== 'string') return 'unmatched';
  return `${req.baseUrl ?? ''}${path}` || path;
}
