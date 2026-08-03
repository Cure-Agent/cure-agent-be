/**
 * 평가 도메인 (docs/specs/27) — architecture.md §3이 P1로 예약해둔 자리다.
 *
 * **컨트롤러가 없다.** 평가는 오프라인 도구이고 엔드포인트를 만들지 않는다 —
 * 소비처는 `scripts/eval-rag.ts`·`scripts/eval-groundedness.ts`와 e2e다.
 */
import { Module } from '@nestjs/common';
import { LlmModule } from '../../infrastructure/llm/llm.module';
import { RetrievalModule } from '../../infrastructure/retrieval/retrieval.module';
import { EvalsetSampler } from './evalset-sampler';
import { createGroundednessJudge } from './groundedness-judge.factory';
import { GROUNDEDNESS_JUDGE } from './groundedness-judge.port';
import { GroundednessEvalService } from './groundedness-eval.service';
import { GuidanceEvalService } from './guidance-eval.service';
import { LabelResolver } from './label-resolver';
import { RagEvalService } from './rag-eval.service';

@Module({
  // LlmModule은 groundedness 평가가 실경로 답변을 생성하기 위해 쓴다 (docs/specs/30)
  imports: [RetrievalModule, LlmModule],
  providers: [
    EvalsetSampler,
    LabelResolver,
    RagEvalService,
    GroundednessEvalService,
    // 구조화기는 LlmModule이 등록·export한다 (docs/specs/33)
    GuidanceEvalService,
    // OPENAI_API_KEY 있으면 실물, 없으면 결정적 fake (리랭커 팩토리 선례)
    { provide: GROUNDEDNESS_JUDGE, useFactory: () => createGroundednessJudge(process.env) },
  ],
  exports: [
    EvalsetSampler,
    LabelResolver,
    RagEvalService,
    GroundednessEvalService,
    GuidanceEvalService,
    GROUNDEDNESS_JUDGE,
  ],
})
export class EvaluationModule {}
