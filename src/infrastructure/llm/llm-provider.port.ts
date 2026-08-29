/**
 * LLM 포트 (architecture.md §3, §11).
 * provider-router가 이 배열(LLM_PROVIDERS)을 우선순위 순서로 소비한다.
 */
import { ProviderErrorOptions } from '../http/provider-http';
import { SupportedLang } from './translation/translator.port';

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
  /**
   * 답변을 쓸 언어 (docs/specs/42). 미지정은 `ko`이며 그 경로는 오늘과 동일하다(기준 3·4).
   * 프롬프트 빌더가 규칙 5를 이 값으로 가르므로 프로바이더까지 내려와야 한다.
   */
  responseLang?: SupportedLang;
  signal?: AbortSignal;
  /**
   * 프로바이더가 usage를 보고할 때 1회 호출된다(선택 — fake·테스트 프로바이더는 미호출).
   * 게이트웨이가 주입하므로 서비스 계층 호출자는 채우지 않는다.
   */
  onUsage?: (usage: LlmTokenUsage) => void;
}

/**
 * 답변가능성 판정 (docs/specs/40) — 「이 근거로 답할 수 있는가」에 대한 생성기 자신의 판단.
 * §29 점수 게이트가 재는 「관련 있는가」와 다른 축이다.
 */
export interface LlmAnswerVerdict {
  insufficientEvidence: boolean;
  /** 근거가 답하지 못한 축. 값은 내부 관측용이며 SSE 계약에는 싣지 않는다 (docs/specs/40) */
  missingAspects: string[];
}

/**
 * 스트림 1건이 실어 나르는 청크 (docs/specs/40).
 *
 * **선택 콜백(`onUsage` 식)이 아니라 판별 유니온인 이유**: 콜백은 fake가 호출하지 않아도 타입이
 * 통과해 e2e가 계약을 지키지 못한다(§3 「fake 치환 없이는 동결이 성립하지 않는다」를 타입이
 * 지켜야 한다). 유니온이면 「verdict가 delta보다 먼저」라는 순서가 한 채널에 실린다.
 *
 * 계약: `verdict`는 **최대 1회**이고 **어떤 `delta`보다 먼저** 온다. **미방출을 허용한다** —
 * 게이트 없음(fail-open)이 유효한 상태이며 anthropic·킬스위치 off가 그 경우다.
 */
export type LlmAnswerChunk =
  | ({ kind: 'verdict' } & LlmAnswerVerdict)
  | { kind: 'delta'; text: string };

export interface LlmProvider {
  readonly name: string;
  /** 실사용 모델 식별자 — GenerationRun.model에 기록된다 (선택: fake·테스트 프로바이더는 미제공, docs/specs/13) */
  readonly model?: string;
  /** 판정·토큰 델타를 순서대로 yield한다. 실패는 LlmProviderError로 던진다. */
  streamAnswer(request: LlmStreamRequest): AsyncIterable<LlmAnswerChunk>;
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
