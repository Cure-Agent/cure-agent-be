import { Module } from '@nestjs/common';
import { createEmbeddingProvider } from './embedding-provider.factory';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from './embedding-provider.port';
import { FakeEmbeddingProvider } from './fake-embedding.provider';

/**
 * 프로바이더는 env가 결정한다 (docs/specs/14):
 * OPENAI_API_KEY가 있으면 실 임베딩, 없으면 결정적 fake 단독(로컬·CI 기본값).
 */
@Module({
  providers: [
    FakeEmbeddingProvider,
    {
      provide: EMBEDDING_PROVIDER,
      inject: [FakeEmbeddingProvider],
      useFactory: (fake: FakeEmbeddingProvider): EmbeddingProvider =>
        createEmbeddingProvider(process.env, fake),
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingModule {}
