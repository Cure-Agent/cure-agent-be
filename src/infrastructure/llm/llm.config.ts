/**
 * 실 LLM 프로바이더 런타임 설정 (docs/specs/13).
 * 전부 선택 env — 키가 없으면 해당 프로바이더를 등록하지 않는다(env.validation 필수화 금지).
 */

export interface OpenAiProviderConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
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

export function resolveLlmConfig(_env: NodeJS.ProcessEnv): LlmRuntimeConfig {
  throw new Error('resolveLlmConfig 미구현 (docs/specs/13)');
}
