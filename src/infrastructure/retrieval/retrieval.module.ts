import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding/embedding.module';
import { createReranker } from './reranker.factory';
import { RERANKER } from './reranker.port';
import { RetrievalService } from './retrieval.service';

@Module({
  imports: [EmbeddingModule],
  providers: [
    RetrievalService,
    // OPENAI_API_KEY 있으면 실물, 없으면 결정적 fake (docs/specs/29 — embedding 팩토리 선례)
    { provide: RERANKER, useFactory: () => createReranker(process.env) },
  ],
  exports: [RetrievalService, RERANKER],
})
export class RetrievalModule {}
