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
 *
 * docs/specs/22(전건 잡)를 위해 세 가지가 더 붙어 있다 — **기존 메서드의 동작은 그대로다**:
 * 문서 누적 등록(`addDocument`), 호출 로그(`listCalls`·`downloadLog`), 다운로드 게이트
 * (`pauseDownloads`·`resumeDownloads`). 잡은 비동기로 도는 동안 테스트가 취소·중복 POST를
 * 밀어넣어야 검증되는데, 게이트가 없으면 fake가 즉시 응답해 잡이 먼저 끝나버린다.
 */
export class FakeGuidelineSource implements GuidelineSourcePort {
  readonly system = 'NCKM';

  /** `listGuidelines`가 받은 옵션 — 잡이 `externalIds`를 실제로 좁혀 넘겼는지 본다 (기준 10) */
  readonly listCalls: ListOptions[] = [];
  /** 실제로 다운로드를 시도한 externalId (순서 보존) — 취소 후 남은 문서를 건드리지 않았음의 근거 (기준 9) */
  readonly downloadLog: string[] = [];

  private items: SourceListItem[] = [];
  private readonly downloads = new Map<string, SourceDownload | Error>();

  /** 열려 있으면 null. 닫혀 있으면 이 promise가 resolve될 때까지 download가 멈춘다 */
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;
  /** `waitForDownloads` 대기자 — 다운로드가 게이트에 도착할 때마다 깨운다 */
  private readonly arrivals: (() => void)[] = [];

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

  /**
   * 목록에 **덧붙이고** 다운로드까지 함께 등록한다 (docs/specs/22).
   * `setItems`는 목록을 통째로 갈아끼우므로 N건짜리 전건 잡을 조립할 수 없다.
   */
  addDocument(item: SourceListItem, download: SourceDownload): this {
    this.items = [...this.items.filter((each) => each.externalId !== item.externalId), { ...item }];
    return this.setDownload(item.externalId, download);
  }

  /** 목록에만 올린다 — 다운로드가 실패하는 문서를 만들 때는 `setFailure`와 짝지어 쓴다 */
  addItem(item: SourceListItem): this {
    this.items = [...this.items.filter((each) => each.externalId !== item.externalId), { ...item }];
    return this;
  }

  /** 계획·로그·게이트를 모두 초기화한다 (테스트 간 상태 누수 방지) */
  reset(): this {
    this.items = [];
    this.downloads.clear();
    this.listCalls.length = 0;
    this.downloadLog.length = 0;
    this.resumeDownloads();
    return this;
  }

  /**
   * 다음 다운로드부터 게이트에서 멈춘다 — 잡이 **도는 중에** 취소·중복 POST·늦은 SSE 연결을
   * 밀어넣기 위한 장치다 (기준 7·8·9). 이미 멈춰 있으면 아무 일도 하지 않는다.
   */
  pauseDownloads(): this {
    if (this.gate) return this;
    this.gate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
    return this;
  }

  /** 멈춰 있던 다운로드를 모두 풀고 게이트를 연다 */
  resumeDownloads(): this {
    this.openGate?.();
    this.gate = null;
    this.openGate = null;
    return this;
  }

  /**
   * 다운로드 시도가 `count`건에 도달할 때까지 기다린다 — 게이트를 닫아둔 상태에서 쓰면
   * "잡이 N번째 문서에 진입했다"는 시점을 잡을 수 있다. 폴링 대신 이걸 쓰는 이유는
   * 경쟁 조건 없이 결정적으로 잡의 진행 지점을 고정하기 위해서다.
   */
  waitForDownloads(count: number, timeoutMs = 5_000): Promise<void> {
    if (this.downloadLog.length >= count) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `다운로드 ${count}건을 기다렸으나 ${this.downloadLog.length}건에서 멈췄습니다: ` +
              `[${this.downloadLog.join(', ')}]`,
          ),
        );
      }, timeoutMs);

      const wake = (): void => {
        if (this.downloadLog.length < count) {
          this.arrivals.push(wake);
          return;
        }
        clearTimeout(timer);
        resolve();
      };
      this.arrivals.push(wake);
    });
  }

  listGuidelines(options: ListOptions = {}): Promise<SourceListItem[]> {
    this.listCalls.push({ ...options });
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

  async download(item: SourceListItem): Promise<SourceDownload> {
    // 게이트보다 **먼저** 기록한다 — 멈춰 있는 동안에도 "여기까지 왔다"가 보여야 한다
    this.downloadLog.push(item.externalId);
    this.arrivals.splice(0).forEach((wake) => wake());
    const gate = this.gate;
    if (gate) await gate;

    const planned = this.downloads.get(item.externalId);
    if (planned instanceof Error) {
      throw planned;
    }
    if (planned === undefined) {
      throw new GuidelineSourceError(`no fake download configured: ${item.externalId}`);
    }

    return {
      body: Buffer.from(planned.body),
      contentType: planned.contentType,
    };
  }
}
