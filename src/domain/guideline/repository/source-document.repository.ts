import { Injectable } from '@nestjs/common';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { SourceDocumentRow, SourceDocumentStatus } from '../persistence/source-document.schema';

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
  findByHash(
    _sourceSystem: string,
    _externalId: string,
    _fileHash: string,
  ): Promise<SourceDocumentRow | null> {
    throw new Error('not implemented');
  }

  insert(_row: SourceDocumentInsert): Promise<void> {
    throw new Error('not implemented');
  }

  /** 동일 해시 재수집 — 새 행 없이 확인 시각만 갱신한다 */
  touchFetchedAt(_id: string, _fetchedAt: Date): Promise<void> {
    throw new Error('not implemented');
  }
}
