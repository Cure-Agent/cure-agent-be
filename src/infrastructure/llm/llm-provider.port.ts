/**
 * LLM 포트 (architecture.md §3, §11).
 * provider-router가 이 배열(LLM_PROVIDERS)을 우선순위 순서로 소비한다.
 */
import { ProviderErrorOptions } from '../http/provider-http';

export const LLM_PROVIDERS = Symbol('LLM_PROVIDERS');

export interface LlmEvidenceContext {
  marker: number; // 답변 인용 마커 [n]
  content: string;
  guidelineTitle: string;
  sectionPath: string[];
}

/** 프로바이더가 보고한 토큰 소비량 — 비용 지표(llm_tokens_total)의 원천 */
export interface LlmTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmStreamRequest {
  question: string;
  evidence: LlmEvidenceContext[];
  signal?: AbortSignal;
  /**
   * 프로바이더가 usage를 보고할 때 1회 호출된다(선택 — fake·테스트 프로바이더는 미호출).
   * 게이트웨이가 주입하므로 서비스 계층 호출자는 채우지 않는다.
   */
  onUsage?: (usage: LlmTokenUsage) => void;
}

export interface LlmProvider {
  readonly name: string;
  /** 실사용 모델 식별자 — GenerationRun.model에 기록된다 (선택: fake·테스트 프로바이더는 미제공, docs/specs/13) */
  readonly model?: string;
  /** 토큰 델타를 순서대로 yield한다. 실패는 LlmProviderError로 던진다. */
  streamAnswer(request: LlmStreamRequest): AsyncIterable<string>;
}

/** 4단 방어(재시도·서킷·rate-limit 차단)가 분류에 사용하는 오류 타입 */
export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly options: ProviderErrorOptions = {},
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}
