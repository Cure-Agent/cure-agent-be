import { Module } from '@nestjs/common';
import { GuidelineModule } from '../../domain/guideline/guideline.module';
import { EmbeddingModule } from '../embedding/embedding.module';
import { createReranker } from './reranker.factory';
import { RERANKER } from './reranker.port';
import { RetrievalService } from './retrieval.service';

@Module({
  // GuidelineModule은 키워드 arm의 어휘 색인(docs/specs/45)을 위해 필요하다.
  // 방향이 이쪽인 이유는 어휘 표가 코퍼스 위에 서기 때문이고, 반대로 두면 순환이 된다.
  imports: [EmbeddingModule, GuidelineModule],
  providers: [
    RetrievalService,
    // OPENAI_API_KEY 있으면 실물, 없으면 결정적 fake (docs/specs/29 — embedding 팩토리 선례)
    { provide: RERANKER, useFactory: () => createReranker(process.env) },
  ],
  exports: [RetrievalService, RERANKER],
})
export class RetrievalModule {}
