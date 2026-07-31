/**
 * 평가 도메인 (docs/specs/27) — architecture.md §3이 P1로 예약해둔 자리다.
 *
 * **컨트롤러가 없다.** 평가는 오프라인 도구이고 엔드포인트를 만들지 않는다 —
 * 소비처는 `scripts/eval-rag.ts`와 e2e다.
 */
import { Module } from '@nestjs/common';
import { RetrievalModule } from '../../infrastructure/retrieval/retrieval.module';
import { LabelResolver } from './label-resolver';
import { RagEvalService } from './rag-eval.service';

@Module({
  imports: [RetrievalModule],
  providers: [LabelResolver, RagEvalService],
  exports: [LabelResolver, RagEvalService],
})
export class EvaluationModule {}
