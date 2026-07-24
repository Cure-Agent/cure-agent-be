/**
 * 실 LLM 프로바이더 런타임 설정 (docs/specs/13).
 * 전부 선택 env — 키가 없으면 해당 프로바이더를 등록하지 않는다(env.validation 필수화 금지).
 */

const DEFAULTS = {
  openaiModel: 'gpt-5.1',
  openaiBaseUrl: 'https://api.openai.com/v1',
  anthropicModel: 'claude-sonnet-5',
  anthropicBaseUrl: 'https://api.anthropic.com/v1',
  maxOutputTokens: 1024,
} as const;

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

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function baseUrl(value: string | undefined, fallback: string): string {
  return (nonEmpty(value) ?? fallback).replace(/\/+$/, '');
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(nonEmpty(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
