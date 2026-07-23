import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EMBEDDING_DIMENSIONS } from '../../domain/guideline/persistence/guideline.schema';
import { EmbeddingProvider } from './embedding-provider.port';

/**
 * 결정적 fake 임베딩: 같은 텍스트 → 항상 같은 벡터.
 * e2e·로컬 인제스트에서 외부 API 없이 파이프라인을 검증하기 위한 구현이다.
 */
@Injectable()
export class FakeEmbeddingProvider implements EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.vectorOf(text)));
  }

  private vectorOf(text: string): number[] {
    const seed = createHash('sha256').update(text).digest().readUInt32BE(0);
    const next = mulberry32(seed);
    return Array.from({ length: EMBEDDING_DIMENSIONS }, () => round6(next() * 2 - 1));
  }
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
