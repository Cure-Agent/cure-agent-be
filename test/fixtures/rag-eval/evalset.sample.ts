/**
 * 평가셋 fixture 컨벤션 (docs/specs/27).
 *
 * **원문이 아니라 구조를 모방한 합성 텍스트다.** 실제 평가셋
 * (test/fixtures/rag-eval/evalset.json)은 역생성 + 검수로 만들어지며, 여기 있는 것은
 * 로더·해석기의 계약을 검증하기 위한 최소 표본이다.
 *
 * 안정 키는 test/fixtures/guideline-samples.ts의 지침과 일치시킨다 — 그래야 e2e에서
 * 인제스트한 코퍼스와 라벨이 실제로 조인된다.
 */
import { EvalSetItem } from '../../../src/domain/evaluation/evalset.types';

/** 답해야 하는 문항 — 기대 근거가 권고번호로 특정된다 (yotongGuideline R1) */
export const answerableSample: EvalSetItem = {
  id: 'eval-answerable-1',
  kind: 'answerable',
  question: '만성 요통 환자에게 침 치료를 권고하는 근거는 무엇인가요?',
  expectedEvidence: [
    {
      guidelineTitle: '요통 한의표준임상진료지침',
      publisher: '한국한의약진흥원',
      recommendationNumber: 'R1',
    },
  ],
  status: 'approved',
  origin: 'reverse-generated',
};

/** 비권고 청크는 섹션 경로로 특정한다 (yotongGuideline 진단 절) */
export const sectionPathSample: EvalSetItem = {
  id: 'eval-answerable-2',
  kind: 'answerable',
  question: '요통 초기 평가에서 먼저 확인해야 할 위험 신호는 무엇인가요?',
  expectedEvidence: [
    {
      guidelineTitle: '요통 한의표준임상진료지침',
      publisher: '한국한의약진흥원',
      sectionPath: ['1', '진단'],
    },
  ],
  status: 'approved',
  origin: 'manual',
};

/** 기권해야 하는 문항 — 코퍼스가 다루지 않는 인접 임상 질문이라 기대 근거가 없다 */
export const abstainSample: EvalSetItem = {
  id: 'eval-abstain-1',
  kind: 'abstain',
  question: '급성 심근경색 환자의 관상동맥 스텐트 시술 적응증은 무엇인가요?',
  expectedEvidence: [],
  status: 'approved',
  origin: 'reverse-generated',
};

/** 검수를 통과하지 못한 문항 — 로더가 평가에서 제외해야 한다 */
export const candidateSample: EvalSetItem = {
  id: 'eval-candidate-1',
  kind: 'answerable',
  question: '침 치료의 시술 빈도는 어떻게 되나요?',
  expectedEvidence: [
    {
      guidelineTitle: '요통 한의표준임상진료지침',
      publisher: '한국한의약진흥원',
      sectionPath: ['2', '치료', '침치료'],
    },
  ],
  status: 'candidate',
  origin: 'reverse-generated',
};

/** 코퍼스에 없는 지침을 가리키는 라벨 — 해석이 0건이면 비영 종료여야 한다 (기준 4) */
export const unresolvableSample: EvalSetItem = {
  id: 'eval-unresolvable-1',
  kind: 'answerable',
  question: '존재하지 않는 지침을 가리키는 라벨입니다.',
  expectedEvidence: [
    {
      guidelineTitle: '없는 지침',
      publisher: '없는 발행처',
      recommendationNumber: 'R9',
    },
  ],
  status: 'approved',
  origin: 'manual',
};
