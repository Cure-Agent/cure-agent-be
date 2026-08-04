import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { dataPurgeConfig } from '../../global/config/data-purge.config';
import { guidelineScanConfig } from '../../global/config/guideline-scan.config';
import { DataPurgeModule } from '../../domain/data-purge/data-purge.module';
import { GuidelineModule } from '../../domain/guideline/guideline.module';
import { DataPurgeCron } from './data-purge.cron';
import { GuidelineRevisionCron } from './guideline-revision.cron';

/**
 * 크론 트리거 배선 (docs/specs/26, 34). 트리거만 담고 판정·통보·삭제는 도메인이 한다.
 * `ScheduleModule.forRoot()`는 app.module이 등록한다.
 */
@Module({
  imports: [
    ConfigModule.forFeature(guidelineScanConfig),
    ConfigModule.forFeature(dataPurgeConfig),
    GuidelineModule,
    DataPurgeModule,
  ],
  providers: [GuidelineRevisionCron, DataPurgeCron],
})
export class SchedulerModule {}
