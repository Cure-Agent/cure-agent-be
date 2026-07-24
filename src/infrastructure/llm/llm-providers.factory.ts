/**
 * LLM_PROVIDERS 배열 구성 (docs/specs/13).
 * 우선순위 openai → anthropic. 실 프로바이더가 하나라도 등록되면 fake는 넣지 않는다
 * — 실패 시 fake 답변이 의료인에게 진짜처럼 노출되는 것은 503보다 위험하기 때문이다.
 */
import { LlmProvider } from './llm-provider.port';

export function createLlmProviders(_env: NodeJS.ProcessEnv, _fake: LlmProvider): LlmProvider[] {
  throw new Error('createLlmProviders 미구현 (docs/specs/13)');
}
