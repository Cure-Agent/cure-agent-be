import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
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
  /** 목록이 준 레코드 수정 시각 — 본문을 받았을 때만 채운다 (docs/specs/26 기준 8·10) */
  sourceModifiedAt?: string | null;
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

  /** 문서 메타 조회용 — 같은 external_id의 최신 행 (docs/specs/19) */
  async findLatestByExternalId(
    sourceSystem: string,
    externalId: string,
  ): Promise<SourceDocumentRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(sourceDocuments)
      .where(
        and(
          eq(sourceDocuments.sourceSystem, sourceSystem),
          eq(sourceDocuments.externalId, externalId),
        ),
      )
      .orderBy(desc(sourceDocuments.fetchedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * **본문을 받은** 최신 행 — 개정 감지의 baseline 원천이다 (docs/specs/26 기준 2·6).
   *
   * `findLatestByExternalId`와 달리 `file_hash IS NOT NULL`로 좁힌다. 본문을 못 받은 실패 행은
   * baseline을 갖지 않으므로, 그 행만 있는 문서는 「받아본 적 없음」으로 후보가 되어야 한다.
   */
  async findLatestFetchedByExternalId(
    sourceSystem: string,
    externalId: string,
  ): Promise<SourceDocumentRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(sourceDocuments)
      .where(
        and(
          eq(sourceDocuments.sourceSystem, sourceSystem),
          eq(sourceDocuments.externalId, externalId),
          isNotNull(sourceDocuments.fileHash),
        ),
      )
      .orderBy(desc(sourceDocuments.fetchedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(row: SourceDocumentInsert): Promise<void> {
    await this.txManager.conn.insert(sourceDocuments).values(row);
  }

  /**
   * 동일 해시 재수집 — 새 행 없이 확인 시각을 갱신한다.
   *
   * **baseline도 함께 갱신한다** (docs/specs/26 기준 9). 파일이 그대로여도 목록의
   * `modify_date`는 오를 수 있고, 그때 baseline을 안 올리면 그 문서가 매일 후보로 떠서
   * 잡이 헛돈다. 「확인했고 파일은 그대로다」를 기록하는 것이 이 갱신의 뜻이다.
   */
  async touchFetchedAt(
    id: string,
    fetchedAt: Date,
    sourceModifiedAt?: string | null,
  ): Promise<void> {
    await this.txManager.conn
      .update(sourceDocuments)
      .set({ fetchedAt, sourceModifiedAt: sourceModifiedAt ?? null })
      .where(eq(sourceDocuments.id, id));
  }
}
