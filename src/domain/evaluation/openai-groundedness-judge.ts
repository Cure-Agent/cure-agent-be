/**
 * OpenAI groundedness 심판 (docs/specs/30).
 * 답변을 주장 단위로 나눠 supported/miscited/unsupported로 채점한다.
 */
import {
  GroundednessJudge,
  GroundednessJudgement,
  GroundednessVerdict,
  JudgeInput,
} from './groundedness-judge.port';

export interface OpenAiJudgeConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/**
 * 루브릭 v3 (issue #216).
 *
 * **v2와의 차이 — 비주장 판정을 예시 나열에서 내용 기준으로 올린다.** qa-v4 재측정
 * (docs/rag-eval/2026-08-02-groundedness-qa-v4.md)의 잔여 오탐 3패턴이 표적이다:
 * ① 마커가 붙은 면책을 「마커 → 주장 → miscited」로 채점(051), ② v2 예시와 표현이 다른
 * 문형 변형 통과(036 「참고하는 것이 적절하다」·025 「직접 제시되지는 않았다」),
 * ③ 근거 상태 메타 발언을 임상 주장으로 채점(037 「근거가 충분합니다」).
 * 남용 가드가 균형추다 — 비주장 문형에 실린 구체 임상 정보는 절 단위로 나눠 여전히
 * 채점한다. 면책 포장이 채점 회피 루프홀이 되면 오탐 제거가 결함 은폐로 뒤집힌다.
 */
export const JUDGE_RUBRIC = [
  '당신은 한의 임상 지침 기반 답변의 근거 충실성(groundedness)을 채점하는 심판입니다.',
  '질문, 근거 목록([1]~[5]), 답변이 주어집니다.',
  '',
  '답변을 임상적 주장 단위로 나누고 각 주장을 다음 세 값 중 하나로 판정하세요:',
  '- supported: 마커가 가리키는 근거가 그 주장을 실제로 뒷받침한다',
  '- miscited: 마커는 달려 있으나 그 근거가 주장을 뒷받침하지 않는다',
  '- unsupported: 어떤 근거에도 없는 임상적 주장이다',
  '',
  '**비주장(주장으로 세지 않고 채점에서 제외)**:',
  '아래 유형은 답변 규칙이 요구하는 문장이므로 claims에 포함하지 마세요.',
  '- 면책: 「최종 판단과 책임은 의료인에게 있다」, 「의료인의 임상 판단이 필요하다」,',
  '  「환자 상태를 고려해 의료인이 결정해야 한다」, 「의료인이 개별 상황에 맞춰 참고하는',
  '  것이 적절하다」, 「의료인이 판단하는 참고 정보로 보는 것이 적절하다」 등',
  '  책임 소재·적용 태도를 밝히는 문장',
  '- 적용 지침: 「실제 진료에서는 환자 상태·증상을 함께 보면서 정하는 것이 적절하다」 등',
  '  새 임상 사실 없이 개별화·적용 방식만 말하는 마무리 문장',
  '- 한계 고지: 「제공된 근거로는 부족하다」, 「근거에 해당 내용이 없다」,',
  '  「근거에서 직접 제시되지는 않았다」, 「구체적으로 제시하기에는 근거가 불충분하다」 등',
  '  근거 부족을 밝히는 문장',
  '- 근거 상태 논평: 「근거가 충분하다」, 「근거들이 일치한다」 등 근거 자체에 대한 메타 발언',
  '- 재질의 유도: 「추가 정보가 필요하다」, 「질문을 구체화해 달라」 등',
  '이 문장들은 unsupported가 아닙니다 — 규칙 준수입니다.',
  '',
  '비주장 판정은 문장의 내용으로만 하세요:',
  '- 마커가 붙어 있어도 내용이 위 유형이면 비주장입니다 — miscited로 세지 마세요.',
  '- 반대로 비주장 문형이라도 구체 임상 정보(처방명·용량·치료 기간·수치·효과)를 새로',
  '  말하는 절은 주장입니다 — 복합문은 절 단위로 나눠 임상 내용 절만 채점하세요.',
  '',
  'JSON만 출력:',
  '{"claims": 총 주장 수, "supported": 수, "miscited": 수, "unsupported": 수,',
  ' "unsupportedExamples": ["무근거 주장 원문 최대 2개"],',
  ' "insufficiencyDisclosed": 근거가 부족한데 답변이 그 사실을 밝혔으면 true,',
  ' "verdict": "grounded"|"partial"|"ungrounded"}',
  '',
  'verdict 기준: 전 주장이 supported면 grounded, unsupported/miscited가 소수면 partial,',
  '다수면 ungrounded.',
].join('\n');

const VERDICTS: readonly GroundednessVerdict[] = ['grounded', 'partial', 'ungrounded'];

export class OpenAiGroundednessJudge implements GroundednessJudge {
  constructor(private readonly config: OpenAiJudgeConfig) {}

  get model(): string {
    return this.config.model;
  }

  async judge(input: JudgeInput): Promise<GroundednessJudgement> {
    const evidence = input.evidence
      .map((item) => `[${item.marker}] (${item.guidelineTitle}) ${item.content}`)
      .join('\n');

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: JUDGE_RUBRIC },
          {
            role: 'user',
            content: `질문: ${input.question}\n\n근거:\n${evidence}\n\n답변:\n${input.answer}`,
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`심판 호출 실패 (${response.status}): ${(await response.text()).slice(0, 200)}`);
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('심판 응답에 본문이 없습니다');

    return normalizeJudgement(JSON.parse(content) as Record<string, unknown>);
  }
}

/**
 * 심판 응답 정규화 — 리랭커(docs/specs/29)와 같은 이유로 관대하게 읽는다.
 * 판정 값이 계약 밖이면 예외를 던져 **호출측이 실패 문항으로 수집**하게 한다(기준 6) —
 * 조용히 기본값을 채우면 지표가 조용히 낙관 오염된다.
 */
export function normalizeJudgement(raw: Record<string, unknown>): GroundednessJudgement {
  const count = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
  };
  const verdict = raw.verdict;
  if (!VERDICTS.includes(verdict as GroundednessVerdict)) {
    throw new Error(`심판 응답의 verdict가 계약 밖입니다: ${String(verdict)}`);
  }

  return {
    claims: count(raw.claims),
    supported: count(raw.supported),
    miscited: count(raw.miscited),
    unsupported: count(raw.unsupported),
    unsupportedExamples: Array.isArray(raw.unsupportedExamples)
      ? raw.unsupportedExamples.filter((e): e is string => typeof e === 'string').slice(0, 2)
      : [],
    insufficiencyDisclosed: raw.insufficiencyDisclosed === true,
    verdict: verdict as GroundednessVerdict,
  };
}
