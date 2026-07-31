/**
 * LLM 포트 (architecture.md §3, §11).
 * provider-router가 이 배열(LLM_PROVIDERS)을 우선순위 순서로 소비한다.
 */
import { ProviderErrorOptions } from '../http/provider-http';

export const LLM_PROVIDERS = Symbol('LLM_PROVIDERS');

/**
 * LLM 스트리밍의 첫 응답(헤더) 수신 상한.
 *
 * OpenAI·Anthropic은 첫 토큰이 준비되기 전에는 응답 헤더를 내보내지 않는다. 즉 이 값은
 * 사실상 TTFT 상한이며, 추론 모델(gpt-5-mini 등)은 사고 시간이 그대로 여기에 포함된다.
 * 기본값 10s로는 실제 근거 프롬프트에서 매 요청이 타임아웃했다 — 실측 TTFT 약 9.5s.
 *
 * 45s인 이유: retry-policy가 프로바이더당 2회 시도하므로 45×2+0.3 ≈ 90s가 최악이고,
 * 호출측 전체 상한 120s 안에 다음 프로바이더로 폴백할 여유(§11-4)가 남는다.
 */
export const LLM_FIRST_BYTE_TIMEOUT_MS = 45_000;

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
