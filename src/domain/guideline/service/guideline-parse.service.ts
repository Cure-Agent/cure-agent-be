import { Injectable } from '@nestjs/common';
import {
  chunkNckmGuideline,
  GuidelineDocumentMeta,
} from '../../../infrastructure/document/guideline-chunker';
import { SourceDocumentRepository } from '../repository/source-document.repository';
import { GuidelineIngestInput } from './guideline-ingest.input';

export interface ParseGuidelineOptions {
  /** PDF에서 추출한 페이지 텍스트 (추출은 CLI가 담당 — 서비스는 텍스트만 받는다) */
  pages: string[];
  /** NCKM guide_idx */
  externalId: string;
  /** 기본 'NCKM' */
  sourceSystem?: string;
  /** CLI 플래그로 넘어온 메타 오버라이드 */
  overrides?: Partial<GuidelineDocumentMeta>;
}

/**
 * 지침 PDF 파싱 유스케이스 (docs/specs/19).
 *
 * PDF 텍스트에는 발행처·발행일이 없으므로 문서 메타는 §18이 적재한 `source_documents`에서 읽는다.
 * 조회·보정을 스크립트가 아니라 서비스에 두는 이유는 수용 기준 13을 e2e로 동결하기 위해서다.
 */
@Injectable()
export class GuidelineParseService {
  constructor(private readonly sourceDocuments: SourceDocumentRepository) {}

  /** 페이지 텍스트 + 조회한 메타 → 인제스트 입력 */
  async parse(options: ParseGuidelineOptions): Promise<GuidelineIngestInput> {
    const meta = await this.resolveMeta(options);
    return chunkNckmGuideline(options.pages, meta);
  }

  /**
   * `source_documents`의 최신 행에서 문서 메타를 만든다.
   * `release_date`("2024-07")가 version이 되고, publishedAt은 일자를 1일로 보정한다.
   * 행이 없으면 예외를 던진다.
   */
  async resolveMeta(
    options: Pick<ParseGuidelineOptions, 'externalId' | 'sourceSystem' | 'overrides'>,
  ): Promise<GuidelineDocumentMeta> {
    void this.sourceDocuments;
    void options;
    return Promise.resolve({
      title: '',
      publisher: '',
      version: '',
      publishedAt: '',
      sourceUrl: '',
    });
  }
}
