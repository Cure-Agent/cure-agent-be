import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { AuthSessionRow, authSessions } from '../persistence/auth-session.schema';

@Injectable()
export class AuthSessionRepository {
  constructor(private readonly txManager: TransactionManager) {}

  async insert(
    row: Pick<AuthSessionRow, 'id' | 'clinicianId' | 'familyId' | 'refreshTokenHash' | 'expiresAt'>,
  ): Promise<void> {
    await this.txManager.conn.insert(authSessions).values(row);
  }

  async findById(id: string): Promise<AuthSessionRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async markRotated(id: string, at: Date): Promise<void> {
    await this.txManager.conn
      .update(authSessions)
      .set({ rotatedAt: at })
      .where(eq(authSessions.id, id));
  }

  /** family 전체 폐기. reuseSessionId가 있으면 해당 세션에 재사용 감지 시각을 남긴다. */
  async revokeFamily(familyId: string, at: Date, reuseSessionId?: string): Promise<void> {
    await this.txManager.conn
      .update(authSessions)
      .set({ revokedAt: at })
      .where(and(eq(authSessions.familyId, familyId), isNull(authSessions.revokedAt)));

    if (reuseSessionId) {
      await this.txManager.conn
        .update(authSessions)
        .set({ reuseDetectedAt: at })
        .where(eq(authSessions.id, reuseSessionId));
    }
  }
}
