/**
 * groundedness 평가 (docs/specs/30).
 *
 * **실경로를 재현한다** — 검색 K=30 → 리랭크 → top-5 → qa-v3 프롬프트 → LlmGateway.
 * 평가만의 지름길을 두면 측정 대상이 프로덕션 답변이 아니게 된다.
 * DB 쓰기는 없다: 영속화는 conversation-stream의 몫이고 여기는 오프라인 도구다.
 */
import { Inject, Injectable } from '@nestjs/common';
import { LlmGateway } from '../../infrastructure/llm/llm-gateway';
import { RERANKER, Reranker } from '../../infrastructure/retrieval/reranker.port';
import { RetrievalService } from '../../infrastructure/retrieval/retrieval.service';
import { EvalSetItem } from './evalset.types';
import {
  GROUNDEDNESS_JUDGE,
  GroundednessJudge,
  GroundednessVerdict,
} from './groundedness-judge.port';

/** 정규식으로 판정 가능한 qa-v3 규칙 — 심판을 부르지 않고 잡는다 */
export interface MechanicalChecks {
  /** 규칙 6 위반 (화면이 평문 렌더링이라 기호가 그대로 노출된다) */
  markdownViolations: number;
  /** 마커가 하나도 없는 답변 — 규칙 2에 따라 인용이 하나도 기록되지 않는다 */
  noMarkerAnswers: number;
}

/** partial·ungrounded 문항 — 리포트가 나열해 다음 프롬프트 개선의 표적이 된다 */
export interface FlaggedAnswer {
  itemId: string;
  question: string;
  verdict: GroundednessVerdict;
  miscited: number;
  unsupported: number;
  unsupportedExamples: string[];
}

/** 생성 또는 채점이 실패한 문항 — 조용히 빠지면 지표가 낙관 오염된다 (docs/specs/27 계보) */
export interface GroundednessFailure {
  itemId: string;
  stage: 'generation' | 'judge';
  reason: string;
}

export interface GroundednessReport {
  /** 이 측정이 잰 생성 계약 — qa-v3 등 (prompt-builder의 PROMPT_VERSION) */
  promptVersion: string;
  judgeModel: string;
  answerableCount: number;
  verdicts: Record<GroundednessVerdict, number>;
  claims: {
    total: number;
    supported: number;
    miscited: number;
    unsupported: number;
  };
  mechanical: MechanicalChecks;
  flagged: FlaggedAnswer[];
  failures: GroundednessFailure[];
}

@Injectable()
export class GroundednessEvalService {
  constructor(
    private readonly retrieval: RetrievalService,
    @Inject(RERANKER) private readonly reranker: Reranker,
    @Inject(GROUNDEDNESS_JUDGE) private readonly judge: GroundednessJudge,
    private readonly llmGateway: LlmGateway,
  ) {}

  /**
   * TODO(docs/specs/30): answerable 문항만 생성·채점해 집계한다.
   * 실패 문항은 예외로 던지지 않고 리포트에 모은다 — 호출측(CLI)이 비영 종료를 판단한다.
   */
  evaluate(_items: EvalSetItem[]): Promise<GroundednessReport> {
    return Promise.reject(new Error('TODO: docs/specs/30 미구현'));
  }
}
