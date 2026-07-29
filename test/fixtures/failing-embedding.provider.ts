import {
  EmbeddingProvider,
  EmbeddingProviderError,
} from '../../src/infrastructure/embedding/embedding-provider.port';
import { FakeEmbeddingProvider } from '../../src/infrastructure/embedding/fake-embedding.provider';

/**
 * 지정한 텍스트 마커가 섞인 입력에서만 던지는 e2e용 임베딩 fake (docs/specs/22 수용 기준 5).
 *
 * `FakeEmbeddingProvider`는 절대 던지지 않아 EMBED 실패 경로를 열 수 없는데, 그 클래스에
 * 실패 스위치를 다는 것은 spec 21 스위트가 그대로 참조하는 fake의 계약을 바꾸는 일이라
 * 별도 fixture로 둔다.
 *
 * **마커에 걸리지 않은 입력은 `FakeEmbeddingProvider`에 그대로 위임한다** — 한 잡 안에
 * 성공 문서와 임베딩 실패 문서를 섞어야 "개별 실패가 잡을 멈추지 않는다"가 검증되기 때문이다.
 */
export class FailingEmbeddingProvider implements EmbeddingProvider {
  private readonly delegate = new FakeEmbeddingProvider();

  /**
   * 좌표계 식별자는 위임 대상과 **같은 값을 유지한다** — 청크에 기록된 모델이 달라지면
   * 검색이 그 청크를 대상에서 빼므로(docs/specs/14) 실패 fixture를 끼웠다는 이유만으로
   * 성공 문서의 적재·검색 단언이 무너진다.
   */
  readonly model = this.delegate.model;

  /** 임베딩 호출마다 넘어온 텍스트 — 실패가 어느 문서에서 났는지 관찰용 */
  readonly calls: string[][] = [];

  private readonly markers = new Set<string>();

  /** 이 문자열이 청크 텍스트에 하나라도 들어 있으면 그 호출 전체가 실패한다 */
  failOn(...markers: string[]): this {
    for (const marker of markers) this.markers.add(marker);
    return this;
  }

  /** 실패 스위치를 전부 내린다 (호출 로그는 `reset()`이 지운다) */
  clearFailures(): this {
    this.markers.clear();
    return this;
  }

  reset(): this {
    this.markers.clear();
    this.calls.length = 0;
    return this;
  }

  embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);

    // 인제스트는 문서 하나의 청크를 한 번에 넘기므로, 한 청크만 걸려도 그 문서의 EMBED 단계가 죽는다
    const hit = [...this.markers].find((marker) =>
      texts.some((text) => text.includes(marker)),
    );
    if (hit !== undefined) {
      return Promise.reject(
        new EmbeddingProviderError(`fake embedding failure: ${hit}`, { retryable: true }),
      );
    }

    return this.delegate.embed(texts);
  }
}
