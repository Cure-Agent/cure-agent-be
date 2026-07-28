import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import {
  SourceDocumentRow,
  SourceDocumentStatus,
  sourceDocuments,
} from '../persistence/source-document.schema';

export interface SourceDocumentInsert {
  id: string;
  sourceSystem: string;
  externalId: string;
  title: string;
  publisher: string;
  releaseDate: string | null;
  sourceUrl: string;
  fileHash: string | null;
  fileBytes: number | null;
  contentType: string | null;
  status: SourceDocumentStatus;
  error: string | null;
  fetchedAt: Date;
}

/** 수집 추적 저장소 (docs/specs/18) — Drizzle 구현 단일 클래스 (§3) */
@Injectable()
export class SourceDocumentRepository {
  constructor(private readonly txManager: TransactionManager) {}

  /** (sourceSystem, externalId, fileHash)로 기존 행을 찾는다. fileHash가 null이면 조회하지 않는다. */
  async findByHash(
    sourceSystem: string,
    externalId: string,
    fileHash: string,
  ): Promise<SourceDocumentRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(sourceDocuments)
      .where(
        and(
          eq(sourceDocuments.sourceSystem, sourceSystem),
          eq(sourceDocuments.externalId, externalId),
          eq(sourceDocuments.fileHash, fileHash),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(row: SourceDocumentInsert): Promise<void> {
    await this.txManager.conn.insert(sourceDocuments).values(row);
  }

  /** 동일 해시 재수집 — 새 행 없이 확인 시각만 갱신한다 */
  async touchFetchedAt(id: string, fetchedAt: Date): Promise<void> {
    await this.txManager.conn
      .update(sourceDocuments)
      .set({ fetchedAt })
      .where(eq(sourceDocuments.id, id));
  }
}
