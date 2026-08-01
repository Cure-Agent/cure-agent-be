import { Injectable } from '@nestjs/common';
import { RerankCandidate, Reranker, RerankResult } from './reranker.port';

/**
 * 결정적 fake 리랭커 — 입력 순서 유지 + 고정 점수 10 (docs/specs/29).
 *
 * 점수가 컷(기본 6) 이상인 이유: e2e 전체가 이 fake를 타므로, 기본 점수가 컷 미만이면
 * 모든 기존 스위트가 기권으로 떨어진다 — fake 임베딩 좌표계에서 §28 기본 컷이 전건 기권을
 * 만들던 사고(setup-env 주석)와 같은 함정이다. 게이트 동작 검증은 테스트가 저점수·순서 뒤집기
 * fake를 provider override로 갈아끼워 수행한다.
 */
@Injectable()
export class FakeReranker implements Reranker {
  readonly model = 'fake-reranker-v1';

  rerank(_question: string, candidates: RerankCandidate[]): Promise<RerankResult> {
    return Promise.resolve({
      order: candidates.map((candidate) => candidate.chunkId),
      top1Relevance: 10,
    });
  }
}
