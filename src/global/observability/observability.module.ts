import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { alertConfig } from '../config/alert.config';
import { IgnorableExceptionClassifier } from './ignorable-exception.classifier';
import { RealTimeAlertSender } from './real-time-alert.sender';

@Global()
@Module({
  imports: [ConfigModule.forFeature(alertConfig)],
  providers: [RealTimeAlertSender, IgnorableExceptionClassifier],
  exports: [RealTimeAlertSender, IgnorableExceptionClassifier],
})
export class ObservabilityModule {}
