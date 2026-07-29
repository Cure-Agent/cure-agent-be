import { Injectable } from '@nestjs/common';
import { NckmConfig } from './nckm.config';
import {
  GuidelineSourceError,
  GuidelineSourcePort,
  ListOptions,
  SourceDownload,
  SourceListItem,
} from './guideline-source.port';

const LIST_PATH = '/nckm/module/practiceGuide/jqgridStartMain.do';
const VIEW_PATH = '/nckm/module/practiceGuide/view.do';
const DOWNLOAD_PATH = '/nckm/module/practiceGuide/download.do';
const MENU_IDX = '14';
/** 국내(INT)·개발완료(E) 86건이 한 번에 들어오는 크기 — jqGrid 기본 `rows`는 먹지 않는다 */
const ROW_COUNT = '100';

/** 목록 JSON의 rows[] 한 건 — 필요한 필드만 좁혀 받는다 */
interface NckmRow {
  guide_idx?: number | string;
  title?: string;
  agency?: string;
  release_date?: string;
  guide_file?: string;
}

/**
 * NCKM 실 구현 (docs/specs/18).
 * **판정하지 않는다** — 받아온 것을 그대로 넘기고, 상태 판정은 서비스가 한다.
 * UA·Referer가 없으면 WAF가 400 `Request Blocked`를 돌려주므로 두 헤더는 필수다.
 */
@Injectable()
export class NckmGuidelineSource implements GuidelineSourcePort {
  readonly system = 'NCKM';

  constructor(private readonly config: NckmConfig) {}

  async listGuidelines(options: ListOptions = {}): Promise<SourceListItem[]> {
    const body = new URLSearchParams({
      viewPage: '1',
      rowCount: ROW_COUNT,
      gubun: 'INT', // 국내
      progress: 'E', // 개발완료
    });

    const response = await fetch(`${this.config.baseUrl}${LIST_PATH}`, {
      method: 'POST',
      headers: {
        'User-Agent': this.config.userAgent,
        Referer: `${this.config.baseUrl}/nckm/module/practiceGuide/index.do?menu_idx=${MENU_IDX}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new GuidelineSourceError(`NCKM 목록 조회 실패 (${response.status})`);
    }

    const payload = (await response.json()) as { rows?: NckmRow[] };
    const items = (payload.rows ?? []).map((row) => this.toItem(row));
    return this.applyFilters(items, options);
  }

  async download(item: SourceListItem): Promise<SourceDownload> {
    await this.throttle();

    const url = new URL(`${this.config.baseUrl}${DOWNLOAD_PATH}`);
    url.searchParams.set('guide_idx', item.externalId);
    url.searchParams.set('file_type', 'pdf');

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        headers: {
          'User-Agent': this.config.userAgent,
          // 해당 문서의 상세 페이지여야 한다 — 다른 Referer는 WAF가 막는다
          Referer: item.sourceUrl,
        },
      });
    } catch (error) {
      // 본문 자체를 못 받은 것만 실패다 — guide_idx와 원인을 실어야 기록만 보고 진단할 수 있다
      throw new GuidelineSourceError(
        `NCKM 다운로드 실패 guide_idx=${item.externalId} ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }

    // **상태 코드로 판정하지 않는다.** 첨부가 없는 문서에 NCKM이 돌려주는 응답이 200 OK에서
    // 500으로 바뀐 적이 있는데(본문은 같은 2,852B 에러 페이지), `!response.ok`로 막던 시절에는
    // 그 변화만으로 §18이 설계한 SKIPPED_NO_ATTACHMENT 경로가 통째로 무력화됐다.
    // 본문을 받았으면 그대로 넘기고 판정은 서비스의 `judge()`에 맡긴다 (포트 계약).
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? '',
    };
  }

  private toItem(row: NckmRow): SourceListItem {
    const externalId = String(row.guide_idx ?? '');
    return {
      externalId,
      title: row.title ?? '',
      // 목록의 agency가 발행 주관기관이다
      publisher: row.agency ?? '',
      releaseDate: row.release_date ?? null,
      sourceUrl: `${this.config.baseUrl}${VIEW_PATH}?guide_idx=${externalId}&menu_idx=${MENU_IDX}`,
      fileName: row.guide_file,
    };
  }

  private applyFilters(items: SourceListItem[], options: ListOptions): SourceListItem[] {
    let selected = items;
    if (options.externalIds !== undefined) {
      const wanted = new Set(options.externalIds);
      selected = selected.filter((item) => wanted.has(item.externalId));
    }
    if (options.limit !== undefined) {
      selected = selected.slice(0, options.limit);
    }
    return selected;
  }

  /** 서버 예의 — 전수 수집 시 770MB를 순차로 받는다 */
  private throttle(): Promise<void> {
    const ms = this.config.requestIntervalMs;
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  }
}
