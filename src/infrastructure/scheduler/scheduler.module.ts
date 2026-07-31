import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { guidelineScanConfig } from '../../global/config/guideline-scan.config';
import { GuidelineModule } from '../../domain/guideline/guideline.module';
import { GuidelineRevisionCron } from './guideline-revision.cron';

/**
 * 크론 트리거 배선 (docs/specs/26). 트리거만 담고 판정·통보는 도메인이 한다.
 * `ScheduleModule.forRoot()`는 app.module이 등록한다.
 */
@Module({
  imports: [ConfigModule.forFeature(guidelineScanConfig), GuidelineModule],
  providers: [GuidelineRevisionCron],
})
export class SchedulerModule {}
