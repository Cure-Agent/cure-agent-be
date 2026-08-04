import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { dataPurgeConfig } from '../../global/config/data-purge.config';
import { DataPurgeRepository } from './repository/data-purge.repository';
import { DataPurgeService } from './service/data-purge.service';

/** 파기 도메인 (docs/specs/34) — 컨트롤러 없음. 진입점은 크론뿐이다 */
@Module({
  imports: [ConfigModule.forFeature(dataPurgeConfig)],
  providers: [DataPurgeService, DataPurgeRepository],
  exports: [DataPurgeService],
})
export class DataPurgeModule {}
