import { Module } from '@nestjs/common';
import { GUIDELINE_SOURCE, GuidelineSourcePort } from './guideline-source.port';
import { resolveNckmConfig } from './nckm.config';
import { NckmGuidelineSource } from './nckm.source';

/**
 * 지침 원본 수집 포트 배선 (docs/specs/18).
 * e2e는 이 provider를 fake로 override한다 — 네트워크에 의존하지 않는다 (§13).
 */
@Module({
  providers: [
    {
      provide: GUIDELINE_SOURCE,
      useFactory: (): GuidelineSourcePort =>
        new NckmGuidelineSource(resolveNckmConfig(process.env)),
    },
  ],
  exports: [GUIDELINE_SOURCE],
})
export class GuidelineSourceModule {}
