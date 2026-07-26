/**
 * OpenAI Embeddings 어댑터 (docs/specs/14).
 * 배치로 나눠 호출하고 입력 순서를 보존하며, 차원이 스키마와 다르면 저장 전에 실패시킨다.
 */
import { EMBEDDING_DIMENSIONS } from '../../domain/guideline/persistence/guideline.schema';
import { fetchStream, parseJson, toProviderError } from '../http/provider-http';
import { OpenAiEmbeddingConfig } from './embedding.config';
import { EmbeddingProvider, EmbeddingProviderError } from './embedding-provider.port';

/** 오류 메시지 접두사 겸 식별자 — LLM 쪽 'openai'와 구분해 로그에서 계열이 드러나게 한다 */
const PROVIDER = 'openai 임베딩';

/** 한 번의 요청에 담는 최대 입력 수 — 토큰 상한·타임아웃을 함께 낮춘다 */
const BATCH_SIZE = 96;

interface EmbeddingItem {
  index: number;
  embedding: number[];
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;

  constructor(private readonly config: OpenAiEmbeddingConfig) {
    this.model = config.model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const result: number[][] = [];

    for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
      const batch = texts.slice(offset, offset + BATCH_SIZE);
      result.push(...(await this.embedBatch(batch)));
    }

    return result;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    const http = { provider: PROVIDER, errorClass: EmbeddingProviderError };
    const response = await fetchStream(
      `${this.config.baseUrl}/embeddings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          input: batch,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      },
      http,
    );

    if (!response.ok) throw await toProviderError(response, http);

    const payload = parseJson(await response.text());
    const data = payload?.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new EmbeddingProviderError(
        `openai 임베딩 응답 개수 불일치: 요청 ${batch.length}, 응답 ${Array.isArray(data) ? data.length : 0}`,
        { retryable: true },
      );
    }

    // API가 순서를 보장하지 않으므로 index로 정렬해 입력 순서에 맞춘다
    return [...(data as EmbeddingItem[])]
      .sort((a, b) => a.index - b.index)
      .map((item) => {
        if (!Array.isArray(item.embedding) || item.embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new EmbeddingProviderError(
            `openai 임베딩 차원 불일치: 기대 ${EMBEDDING_DIMENSIONS}, 응답 ${item.embedding?.length ?? 0}`,
          );
        }
        return item.embedding;
      });
  }
}
