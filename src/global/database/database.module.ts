import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Pool } from 'pg';
import { databaseConfig } from '../config/database.config';
import { DRIZZLE, PG_POOL, drizzleProvider, poolProvider } from './drizzle.provider';
import { TransactionManager } from './transaction-manager';

@Global()
@Module({
  imports: [ConfigModule.forFeature(databaseConfig)],
  providers: [poolProvider, drizzleProvider, TransactionManager],
  exports: [DRIZZLE, PG_POOL, TransactionManager],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
