import { Provider } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { databaseConfig } from '../config/database.config';

export const PG_POOL = Symbol('PG_POOL');
export const DRIZZLE = Symbol('DRIZZLE');

/** 쿼리 빌더 공통 인터페이스 — 트랜잭션·일반 커넥션 양쪽을 수용한다. */
export type DbConn = Pick<NodePgDatabase, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export const poolProvider: Provider = {
  provide: PG_POOL,
  inject: [databaseConfig.KEY],
  useFactory: (config: ConfigType<typeof databaseConfig>) =>
    new Pool({ connectionString: config.url }),
};

export const drizzleProvider: Provider = {
  provide: DRIZZLE,
  inject: [PG_POOL],
  useFactory: (pool: Pool): NodePgDatabase => drizzle(pool),
};
