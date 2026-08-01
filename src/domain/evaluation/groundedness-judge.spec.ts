// docs/specs/30 수용 기준 7·8 동결 테스트 — 구현 중 수정 금지
// (「루브릭 v3」 블록은 issue #216에서 추가 — 기준 7의 기존 단언은 손대지 않는다)
import { FakeGroundednessJudge } from './fake-groundedness-judge';
import { createGroundednessJudge } from './groundedness-judge.factory';
import {
  JUDGE_RUBRIC,
  OpenAiGroundednessJudge,
} from './openai-groundedness-judge';

describe('spec 30: groundedness 심판', () => {
  describe('기준 7: 루브릭 v2의 비주장 예외', () => {
    it('기준 7a: 면책·의료인 판단 문구를 비주장으로 제외한다고 명시한다', () => {
      expect(JUDGE_RUBRIC).toMatch(
        /의료인|면책|disclaimer|clinician|medical professional/i,
      );
      expect(JUDGE_RUBRIC).toMatch(
        /비주장|주장(?:으로)?\s*(?:보지|세지|분류하지)|(?:채점|평가|집계)(?:에서)?\s*제외|not\s+(?:an?\s+)?claim|exclude/i,
      );
    });

    it('기준 7b: 근거 부족·한계 고지 문구를 비주장으로 제외한다고 명시한다', () => {
      expect(JUDGE_RUBRIC).toMatch(
        /한계\s*고지|근거.{0,20}(?:부족|불충분)|insufficien|lack\s+of\s+evidence/i,
      );
      expect(JUDGE_RUBRIC).toMatch(
        /비주장|주장(?:으로)?\s*(?:보지|세지|분류하지)|(?:채점|평가|집계)(?:에서)?\s*제외|not\s+(?:an?\s+)?claim|exclude/i,
      );
    });

    it('기준 7c: supported·miscited·unsupported 세 판정 값을 각각 정의한다', () => {
      expect(JUDGE_RUBRIC).toContain('supported');
      expect(JUDGE_RUBRIC).toContain('miscited');
      expect(JUDGE_RUBRIC).toContain('unsupported');
    });
  });

  describe('루브릭 v3: qa-v4 잔여 오탐 예외 (issue #216)', () => {
    // qa-v4 재측정(docs/rag-eval)에서 v2가 놓친 오탐 3패턴 — 마커 붙은 면책을
    // miscited로 채점, 예시 밖 문형 변형 통과, 근거 메타 발언을 주장으로 채점.
    it('마커가 붙어 있어도 내용이 비주장이면 miscited로 세지 않는다고 명시한다', () => {
      expect(JUDGE_RUBRIC).toContain('마커가 붙어 있어도');
      expect(JUDGE_RUBRIC).toContain('miscited로 세지 마세요');
    });

    it('적용 지침·근거 상태 논평을 비주장 유형으로 나열한다', () => {
      expect(JUDGE_RUBRIC).toContain('적용 지침');
      expect(JUDGE_RUBRIC).toContain('근거 상태 논평');
    });

    it('비주장 문형에 실린 구체 임상 정보는 절 단위로 채점한다는 남용 가드를 명시한다', () => {
      // 면책 포장이 채점 회피 루프홀이 되면 오탐 제거가 결함 은폐로 뒤집힌다
      expect(JUDGE_RUBRIC).toContain('구체 임상 정보');
      expect(JUDGE_RUBRIC).toContain('절 단위');
    });
  });

  describe('기준 8: OPENAI_API_KEY에 따른 팩토리 등록 정책', () => {
    it('기준 8a·8b: 키가 없거나 비면 fake이고 키가 있으면 지정 모델의 실물 심판이다', () => {
      const withoutKey = createGroundednessJudge({});
      const withEmptyKey = createGroundednessJudge({ OPENAI_API_KEY: '' });

      expect(withoutKey).toBeInstanceOf(FakeGroundednessJudge);
      expect(withoutKey.model).toMatch(/fake/i);
      expect(withEmptyKey).toBeInstanceOf(FakeGroundednessJudge);
      expect(withEmptyKey.model).toMatch(/fake/i);

      const withKey = createGroundednessJudge({
        OPENAI_API_KEY: 'groundedness-judge-test-key',
        OPENAI_MODEL: 'groundedness-judge-model-test',
      });

      expect(withKey).toBeInstanceOf(OpenAiGroundednessJudge);
      expect(withKey.model).toBe('groundedness-judge-model-test');
    });
  });
});
