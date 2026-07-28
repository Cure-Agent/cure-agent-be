import {
  GuidelineSourceError,
  GuidelineSourcePort,
  ListOptions,
  SourceDownload,
  SourceListItem,
} from '../../src/infrastructure/guideline-source/guideline-source.port';

/**
 * e2e용 가짜 지침 원본 제공자 (docs/specs/18).
 * 문서별 raw 응답 또는 네트워크 실패를 테스트가 지정하므로, 서비스의 상태 판정 경로를
 * 외부 HTTP 없이 그대로 검증할 수 있다. 인스턴스마다 상태가 독립적이다.
 */
export class FakeGuidelineSource implements GuidelineSourcePort {
  readonly system = 'NCKM';

  private items: SourceListItem[] = [];
  private readonly downloads = new Map<string, SourceDownload | Error>();

  setItems(items: SourceListItem[]): this {
    this.items = items.map((item) => ({ ...item }));
    return this;
  }

  setDownload(externalId: string, download: SourceDownload): this {
    this.downloads.set(externalId, {
      body: Buffer.from(download.body),
      contentType: download.contentType,
    });
    return this;
  }

  setFailure(externalId: string, error: Error = new GuidelineSourceError('network failure')): this {
    this.downloads.set(externalId, error);
    return this;
  }

  listGuidelines(options: ListOptions = {}): Promise<SourceListItem[]> {
    let selected = this.items;

    if (options.externalIds !== undefined) {
      const externalIds = new Set(options.externalIds);
      selected = selected.filter((item) => externalIds.has(item.externalId));
    }
    if (options.limit !== undefined) {
      selected = selected.slice(0, options.limit);
    }

    return Promise.resolve(selected.map((item) => ({ ...item })));
  }

  download(item: SourceListItem): Promise<SourceDownload> {
    const planned = this.downloads.get(item.externalId);
    if (planned instanceof Error) {
      return Promise.reject(planned);
    }
    if (planned === undefined) {
      return Promise.reject(
        new GuidelineSourceError(`no fake download configured: ${item.externalId}`),
      );
    }

    return Promise.resolve({
      body: Buffer.from(planned.body),
      contentType: planned.contentType,
    });
  }
}
