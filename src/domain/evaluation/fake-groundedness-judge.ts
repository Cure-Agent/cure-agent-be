import { Injectable } from '@nestjs/common';
import {
  GroundednessJudge,
  GroundednessJudgement,
  JudgeInput,
} from './groundedness-judge.port';

/**
 * 결정적 fake 심판 (docs/specs/30) — 근거 내용을 읽지 않고 **마커 유무로만** 판정한다.
 *
 * 같은 입력 → 같은 판정이므로 집계 결정성(기준 3)이 성립한다. 실물 심판의 의미 판정을
 * 흉내내지 않는 이유: 흉내내면 e2e가 심판 품질에 의존하게 되고, 그건 오프라인 측정의
 * 몫이지 동결 테스트의 몫이 아니다. miscited는 근거 대조가 필요하므로 항상 0이다.
 */
@Injectable()
export class FakeGroundednessJudge implements GroundednessJudge {
  readonly model = 'fake-judge-v1';

  judge(input: JudgeInput): Promise<GroundednessJudgement> {
    const sentences = input.answer
      .split(/[.!?\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const supported = sentences.filter((s) => /\[\d\]/.test(s));
    const unsupported = sentences.filter((s) => !/\[\d\]/.test(s));

    return Promise.resolve({
      claims: sentences.length,
      supported: supported.length,
      miscited: 0,
      unsupported: unsupported.length,
      unsupportedExamples: unsupported.slice(0, 2),
      // miscited가 항상 0이므로(근거 대조는 실물 심판의 몫) 예시도 항상 비어 있다
      miscitedExamples: [],
      insufficiencyDisclosed: false,
      verdict: unsupported.length === 0 ? 'grounded' : 'partial',
    });
  }
}
