import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ulid } from 'ulid';
import {
  GUIDELINE_SOURCE,
  GuidelineSourcePort,
  SourceListItem,
} from '../../../infrastructure/guideline-source/guideline-source.port';
import { SourceDocumentRepository } from '../repository/source-document.repository';
import { SourceDocumentStatus } from '../persistence/source-document.schema';

export interface AcquireOptions {
  limit?: number;
  externalIds?: string[];
  /** 다운로드한 PDF를 쓸 디렉토리. 미지정이면 파일을 쓰지 않는다. */
  outDir?: string;
}

export interface AcquireItemResult {
  externalId: string;
  status: SourceDocumentStatus;
  /** 기존 행과 같은 해시라 새로 저장하지 않은 경우 true */
  unchanged: boolean;
}

export interface AcquireResult {
  total: number;
  fetched: number;
  skipped: number;
  failed: number;
  unchanged: number;
  items: AcquireItemResult[];
}

/**
 * 단건 수집 결과 (docs/specs/21).
 * 배치(`acquire`)와 달리 **본문을 그대로 돌려준다** — 파이프라인이 메모리에서 파싱하고 버리기
 * 때문이다. 디스크에 쓰면 누적되고, 현재 수집 경로에는 삭제 코드가 없다.
 */
export interface AcquiredDocument {
  item: SourceListItem;
  status: SourceDocumentStatus;
  unchanged: boolean;
  /** FETCHED일 때만 채워진다 */
  body: Buffer | null;
  /** 응답이 실제로 준 타입 — docs/specs/22의 `stages.acquire.contentType`에 그대로 실린다 */
  contentType: string;
}

const PDF_MAGIC = '%PDF';
const ERROR_MAX_LENGTH = 2000;

/** 본문을 받은 뒤의 판정 결과 — 상태와 함께 기록할 값을 담는다 */
interface Verdict {
  status: SourceDocumentStatus;
  error: string | null;
  /** FETCHED일 때만 파일로 저장한다 */
  persist: boolean;
}

/**
 * 지침 원본 수집 (docs/specs/18).
 * 포트는 받아온 것만 넘기고, 상태 판정(FETCHED/SKIPPED_NO_ATTACHMENT/FAILED)과
 * 매직바이트 검사는 여기서 한다. 개별 문서 실패가 배치를 중단시키지 않는다.
 */
@Injectable()
export class GuidelineAcquisitionService {
  private readonly logger = new Logger(GuidelineAcquisitionService.name);

  constructor(
    @Inject(GUIDELINE_SOURCE) private readonly source: GuidelineSourcePort,
    private readonly repository: SourceDocumentRepository,
  ) {}

  /** source_documents.source_system에 기록되는 출처 식별자 — 메타 조회 시 같은 값을 써야 한다 */
  get sourceSystem(): string {
    return this.source.system;
  }

  async acquire(options: AcquireOptions = {}): Promise<AcquireResult> {
    const items = await this.source.listGuidelines({
      limit: options.limit,
      externalIds: options.externalIds,
    });

    const results: AcquireItemResult[] = [];
    for (const item of items) {
      // 개별 문서의 실패가 배치를 중단시키지 않는다 (수용 기준 7)
      const acquired = await this.acquireOne(item, options.outDir);
      // 본문은 배치 결과에 싣지 않는다 — 86건이면 수백 MB가 그대로 메모리에 남는다
      results.push({
        externalId: acquired.externalId,
        status: acquired.status,
        unchanged: acquired.unchanged,
      });
    }

    return {
      total: results.length,
      fetched: results.filter((r) => r.status === 'FETCHED').length,
      skipped: results.filter((r) => r.status === 'SKIPPED_NO_ATTACHMENT').length,
      failed: results.filter((r) => r.status === 'FAILED').length,
      unchanged: results.filter((r) => r.unchanged).length,
      items: results,
    };
  }

  /**
   * 원본 목록만 조회한다 (docs/specs/22) — 전건 잡이 처리 대상을 정할 때 쓴다.
   * 다운로드는 하지 않으므로 목록 크기와 무관하게 싸다.
   */
  listDocuments(externalIds?: string[]): Promise<SourceListItem[]> {
    return this.source.listGuidelines({ externalIds });
  }

  /**
   * 문서 1건을 수집해 본문과 함께 돌려준다 (docs/specs/21). 파일은 쓰지 않는다.
   * 원본 목록에 그 externalId가 없으면 `null` — 못 가져온 것(FAILED)과 없는 것을 구분한다.
   */
  async acquireDocument(externalId: string): Promise<AcquiredDocument | null> {
    const [item] = await this.source.listGuidelines({ externalIds: [externalId] });
    if (!item) return null;

    // outDir을 주지 않으므로 디스크에 쓰지 않는다 — 파이프라인은 메모리에서 파싱하고 버린다
    const result = await this.acquireOne(item);
    return {
      item,
      status: result.status,
      unchanged: result.unchanged,
      body: result.body,
      contentType: result.contentType,
    };
  }

  private async acquireOne(
    item: SourceListItem,
    outDir?: string,
  ): Promise<AcquireItemResult & { body: Buffer | null; contentType: string }> {
    const fetchedAt = new Date();

    let body: Buffer;
    let contentType: string;
    try {
      const download = await this.source.download(item);
      body = download.body;
      contentType = download.contentType;
    } catch (error) {
      // 본문 자체를 받지 못했다 — 해시가 없어 partial unique 대상 밖이고, 이력으로 누적된다
      await this.repository.insert({
        id: ulid(),
        sourceSystem: this.source.system,
        externalId: item.externalId,
        title: item.title,
        publisher: item.publisher,
        releaseDate: item.releaseDate,
        sourceUrl: item.sourceUrl,
        fileHash: null,
        fileBytes: null,
        contentType: null,
        status: 'FAILED',
        error: truncate(String(error instanceof Error ? error.message : error)),
        fetchedAt,
      });
      this.logger.warn(`수집 실패 ${item.externalId}: ${String(error)}`);
      return {
        externalId: item.externalId,
        status: 'FAILED',
        unchanged: false,
        body: null,
        contentType: '',
      };
    }

    const verdict = judge(body, contentType);
    const fileHash = sha256(body);

    // 같은 해시가 이미 있으면 새 행을 만들지 않는다 (수용 기준 5) —
    // 본문을 받은 이상 SKIPPED·FAILED도 해시를 갖기 때문에 이 경로가 세 상태 모두에서 성립한다.
    const existing = await this.repository.findByHash(
      this.source.system,
      item.externalId,
      fileHash,
    );
    if (existing) {
      await this.repository.touchFetchedAt(existing.id, fetchedAt);
      // 행을 새로 만들지 않았을 뿐 본문은 받아왔다 — 재적재 판정은 호출자가 내용으로 한다
      return {
        externalId: item.externalId,
        status: verdict.status,
        unchanged: true,
        body: verdict.persist ? body : null,
        contentType,
      };
    }

    if (verdict.persist && outDir) {
      await this.writeFile(outDir, item, body);
    }

    await this.repository.insert({
      id: ulid(),
      sourceSystem: this.source.system,
      externalId: item.externalId,
      title: item.title,
      publisher: item.publisher,
      releaseDate: item.releaseDate,
      sourceUrl: item.sourceUrl,
      fileHash,
      fileBytes: body.length,
      contentType,
      status: verdict.status,
      error: verdict.error,
      fetchedAt,
    });

    return {
      externalId: item.externalId,
      status: verdict.status,
      unchanged: false,
      body: verdict.persist ? body : null,
      contentType,
    };
  }

  private async writeFile(outDir: string, item: SourceListItem, body: Buffer): Promise<void> {
    await mkdir(outDir, { recursive: true });
    // 경로 조작 방지: 목록이 준 파일명에서 디렉토리 성분을 제거한다
    const name = item.fileName ? basename(item.fileName) : `${item.externalId}.pdf`;
    await writeFile(join(outDir, name), body);
  }
}

/**
 * 본문 판정. 상태코드만으로는 성공을 알 수 없다 —
 * 첨부가 없는 문서도 200 OK로 HTML 에러 페이지를 돌려주기 때문이다 (docs/specs/18 실측).
 */
function judge(body: Buffer, contentType: string): Verdict {
  if (contentType.toLowerCase().includes('text/html')) {
    return {
      status: 'SKIPPED_NO_ATTACHMENT',
      error: null,
      persist: false,
    };
  }
  if (!body.subarray(0, PDF_MAGIC.length).toString('latin1').startsWith(PDF_MAGIC)) {
    return {
      status: 'FAILED',
      error: truncate(
        `PDF 매직바이트 불일치 (content-type=${contentType}, bytes=${body.length})`,
      ),
      persist: false,
    };
  }
  return { status: 'FETCHED', error: null, persist: true };
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function truncate(value: string): string {
  return value.slice(0, ERROR_MAX_LENGTH);
}
