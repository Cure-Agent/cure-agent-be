/**
 * OpenAI Embeddings 어댑터 (docs/specs/14).
 * 배치로 나눠 호출하고 입력 순서를 보존하며, 차원이 스키마와 다르면 저장 전에 실패시킨다.
 */
import { EMBEDDING_DIMENSIONS } from '../../domain/guideline/persistence/guideline.schema';
import { fetchStream, parseJson } from '../llm/provider-http';
import { OpenAiEmbeddingConfig } from './embedding.config';
import { EmbeddingProvider, EmbeddingProviderError } from './embedding-provider.port';

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
    let response: Response;
    try {
      // 연결 타임아웃(10s)만 spec 13의 공통 유틸을 재사용한다
      response = await fetchStream(
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
        'openai-embedding',
      );
    } catch (error) {
      // 연결 실패·타임아웃 — 오류 타입만 임베딩 계열로 옮긴다(호출자가 LLM 오류로 오인하지 않도록)
      throw new EmbeddingProviderError(String((error as Error)?.message ?? error), {
        retryable: true,
      });
    }

    if (!response.ok) throw await toStatusError(response);

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

async function toStatusError(response: Response): Promise<EmbeddingProviderError> {
  const detail = (await response.text().catch(() => '(본문 없음)')).slice(0, 300);

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    return new EmbeddingProviderError(`openai 임베딩 rate limit (429): ${detail}`, {
      rateLimited: true,
      retryAfterSec:
        Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : undefined,
    });
  }
  if (response.status >= 500) {
    return new EmbeddingProviderError(
      `openai 임베딩 서버 오류 (${response.status}): ${detail}`,
      { retryable: true },
    );
  }
  return new EmbeddingProviderError(`openai 임베딩 요청 실패 (${response.status}): ${detail}`, {
    retryable: false,
  });
}
