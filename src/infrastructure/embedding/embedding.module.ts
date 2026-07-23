import { Module } from '@nestjs/common';
import { EMBEDDING_PROVIDER } from './embedding-provider.port';
import { FakeEmbeddingProvider } from './fake-embedding.provider';

@Module({
  providers: [{ provide: EMBEDDING_PROVIDER, useClass: FakeEmbeddingProvider }],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingModule {}
