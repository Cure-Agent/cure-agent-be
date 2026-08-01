/**
 * OpenAI groundedness 심판 (docs/specs/30).
 * 답변을 주장 단위로 나눠 supported/miscited/unsupported로 채점한다.
 */
import {
  GroundednessJudge,
  GroundednessJudgement,
  JudgeInput,
} from './groundedness-judge.port';

export interface OpenAiJudgeConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/**
 * TODO(docs/specs/30 기준 7): 루브릭 v2 — 면책·한계 고지를 비주장으로 제외하는 예외를
 * 명시적 예시로 나열한다 (파일럿 오탐: qa-v3 규칙 3·4가 요구하는 문구를 무근거로 채점).
 */
export const JUDGE_RUBRIC = 'TODO: docs/specs/30 미구현';

export class OpenAiGroundednessJudge implements GroundednessJudge {
  constructor(private readonly config: OpenAiJudgeConfig) {}

  get model(): string {
    return this.config.model;
  }

  /** TODO(docs/specs/30): 루브릭 v2로 채점한다 */
  judge(_input: JudgeInput): Promise<GroundednessJudgement> {
    return Promise.reject(new Error('TODO: docs/specs/30 미구현'));
  }
}
