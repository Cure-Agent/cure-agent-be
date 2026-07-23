import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ClsService } from 'nestjs-cls';
import { DRIZZLE, DbConn } from './drizzle.provider';

const TX_KEY = 'drizzle-tx';

/**
 * CLS 기반 트랜잭션 전파 (architecture.md §3).
 * - Service: `txManager.run(async () => { ...여러 repository 호출... })`
 * - Repository: 쿼리마다 `txManager.conn` 사용 — 트랜잭션 안이면 tx, 밖이면 풀 커넥션
 */
@Injectable()
export class TransactionManager {
  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase,
    private readonly cls: ClsService,
  ) {}

  get conn(): DbConn {
    if (this.cls.isActive()) {
      const tx = this.cls.get<DbConn | undefined>(TX_KEY);
      if (tx) return tx;
    }
    return this.db;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const execute = (): Promise<T> =>
      this.db.transaction(async (tx) => {
        const prev = this.cls.get<DbConn | undefined>(TX_KEY);
        this.cls.set(TX_KEY, tx as unknown as DbConn);
        try {
          return await fn();
        } finally {
          this.cls.set(TX_KEY, prev);
        }
      });

    // HTTP 요청 밖(스크립트 등)에서 호출되면 CLS 컨텍스트를 새로 연다
    return this.cls.isActive() ? execute() : this.cls.run(execute);
  }
}
