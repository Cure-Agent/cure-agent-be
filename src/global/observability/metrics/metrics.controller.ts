/**
 * Prometheus 스크레이프 엔드포인트 (docs/specs/12 §운영 관측).
 *
 * 공통 응답 봉투(§10.2)를 적용하지 않는다 — Prometheus 텍스트 노출 포맷이어야 하므로
 * @Res로 직접 응답한다(ApiResponseInterceptor는 headersSent를 보고 비켜난다).
 * 외부 노출 차단은 nginx가 담당한다 — 앱은 compose 내부망에서만 스크레이프된다.
 */
import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../security/public.decorator';
import { MetricsService } from './metrics.service';

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @ApiExcludeEndpoint()
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(await this.metrics.scrape());
  }
}
