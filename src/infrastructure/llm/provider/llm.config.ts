/**
 * 실 LLM 프로바이더 런타임 설정 (docs/specs/13).
 * 전부 선택 env — 키가 없으면 해당 프로바이더를 등록하지 않는다(env.validation 필수화 금지).
 */
import { baseUrl, nonEmpty, positiveInt } from '../../http/env';

const DEFAULTS = {
  // gpt-5-mini에서 상향. 추론 모델의 사고 시간이 곧 TTFT인데(첫 토큰 전까지 헤더가 안 온다)
  // gpt-5-mini는 기본 강도에서 실측 9.5~23s였다. gpt-5.4-mini는 기본 강도로도 TTFT 중앙 0.8s이고
  // 마커 정확도·모순 근거 처리 검증에서 동률(3/3)이었다. 요청당 비용은 +28%($0.00117→$0.00150).
  openaiModel: 'gpt-5.4-mini',
  openaiBaseUrl: 'https://api.openai.com/v1',
  // 'none' = reasoning_effort 미전송 → 모델 기본 강도. gpt-5.4-mini는 기본으로도 충분히 빨라
  // 강도를 낮출 이유가 없다. 느린 추론 모델로 되돌릴 때만 low 등으로 지정한다.
  openaiReasoningEffort: 'none',
  anthropicModel: 'claude-haiku-4-5',
  anthropicBaseUrl: 'https://api.anthropic.com/v1',
  // 추론 모델은 사고 토큰을 이 예산에서 함께 쓴다 — 1024에서는 기본 강도 실측이 832(추론 704 +
  // 출력 128)로 81%까지 차서, 질문이 조금만 어려워도 답변이 잘렸다. 상한일 뿐 미사용분은
  // 과금되지 않으므로 넉넉히 잡는다.
  maxOutputTokens: 4096,
} as const;

/** 비추론 모델은 reasoning_effort를 400(Unrecognized request argument)으로 거부한다 — 'none'이면 미전송 */
const NO_REASONING_EFFORT = 'none';

export interface OpenAiProviderConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
  /** 비우면 reasoning_effort를 보내지 않는다 (비추론 모델 호환) */
  reasoningEffort?: string | null;
}

export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
}

export interface LlmRuntimeConfig {
  openai: OpenAiProviderConfig | null;
  anthropic: AnthropicProviderConfig | null;
}

/** OPENAI_MODEL을 비추론 모델로 바꾸면 반드시 'none'으로 함께 꺼야 한다 (400 거부) */
function resolveReasoningEffort(value: string | undefined): string | null {
  const effort = nonEmpty(value) ?? DEFAULTS.openaiReasoningEffort;
  return effort === NO_REASONING_EFFORT ? null : effort;
}

export function resolveLlmConfig(env: NodeJS.ProcessEnv): LlmRuntimeConfig {
  const maxOutputTokens = positiveInt(env.LLM_MAX_OUTPUT_TOKENS, DEFAULTS.maxOutputTokens);
  const openaiKey = nonEmpty(env.OPENAI_API_KEY);
  const anthropicKey = nonEmpty(env.ANTHROPIC_API_KEY);

  return {
    openai: openaiKey
      ? {
          apiKey: openaiKey,
          model: nonEmpty(env.OPENAI_MODEL) ?? DEFAULTS.openaiModel,
          baseUrl: baseUrl(env.OPENAI_BASE_URL, DEFAULTS.openaiBaseUrl),
          maxOutputTokens,
          reasoningEffort: resolveReasoningEffort(env.OPENAI_REASONING_EFFORT),
        }
      : null,
    anthropic: anthropicKey
      ? {
          apiKey: anthropicKey,
          model: nonEmpty(env.ANTHROPIC_MODEL) ?? DEFAULTS.anthropicModel,
          baseUrl: baseUrl(env.ANTHROPIC_BASE_URL, DEFAULTS.anthropicBaseUrl),
          maxOutputTokens,
        }
      : null,
  };
}
