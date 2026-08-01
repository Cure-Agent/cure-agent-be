/**
 * OpenAI 리스트와이즈 리랭커 (docs/specs/29).
 * 후보 30개(발췌 300자)를 한 번에 주고 상위 5개 + top-1 관련도(0~10)를 JSON으로 받는다 —
 * 실측(2026-08-01, 74문항)에서 이 구성이 Recall@5 0.983·파싱 실패 0건이었다.
 */
import { RerankCandidate, Reranker, RerankResult } from './reranker.port';

export interface OpenAiRerankerConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export class OpenAiReranker implements Reranker {
  constructor(private readonly config: OpenAiRerankerConfig) {}

  get model(): string {
    return this.config.model;
  }

  /** TODO(docs/specs/29): 리스트와이즈 재정렬 호출 — 실패는 예외로 던진다(호출측 폴백) */
  rerank(_question: string, _candidates: RerankCandidate[]): Promise<RerankResult> {
    return Promise.reject(new Error('TODO: docs/specs/29 미구현'));
  }
}
