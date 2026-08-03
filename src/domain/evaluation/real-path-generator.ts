/**
 * 평가용 실경로 답변 생성 (docs/specs/30·33 공용).
 *
 * **평가만의 지름길을 두지 않는다** — 검색 K=30 → 리랭크 → top-5 → LlmGateway는 프로덕션
 * 스트림과 같은 순서다. 두 평가(groundedness·guidance)가 각자 재현하면 한쪽만 낡아 «무엇을
 * 쟀는가»가 조용히 갈라지므로 한 곳에서 읽는다.
 */
import { LlmGateway } from '../../infrastructure/llm/llm-gateway';
import { Reranker } from '../../infrastructure/retrieval/reranker.port';
import {
  RETRIEVAL_TOP_K,
  RetrievalService,
  RetrievedEvidence,
} from '../../infrastructure/retrieval/retrieval.service';

export interface RealPathDeps {
  retrieval: RetrievalService;
  reranker: Reranker;
  llmGateway: LlmGateway;
}

export interface RealPathArgs {
  /** 검색에 쓰는 질문 — 실경로에서 환자 프로필 합성 **전**의 원 질문이다 */
  retrievalQuestion: string;
  /** 프롬프트에 싣는 질문. 생략하면 retrievalQuestion과 같다 (GUIDELINE_QA 경로) */
  promptQuestion?: string;
}

export async function generateRealPathAnswer(
  deps: RealPathDeps,
  args: RealPathArgs,
): Promise<{ answer: string; top: RetrievedEvidence[] }> {
  const results = await deps.retrieval.search(
    args.retrievalQuestion,
    undefined,
    deps.retrieval.rerankCandidates,
  );
  let top = results.slice(0, RETRIEVAL_TOP_K);
  try {
    const reranked = await deps.reranker.rerank(
      args.retrievalQuestion,
      results.map((row) => ({
        chunkId: row.chunk.id,
        content: row.chunk.content,
        guidelineTitle: row.guideline.title,
      })),
    );
    const byChunkId = new Map(results.map((row) => [row.chunk.id, row]));
    const ordered = reranked.order
      .map((chunkId) => byChunkId.get(chunkId))
      .filter((row): row is RetrievedEvidence => row !== undefined)
      .slice(0, RETRIEVAL_TOP_K);
    if (ordered.length > 0) top = ordered;
  } catch {
    // 코사인 순위 유지 — 평가가 리랭커 가용성에 묶이면 생성 축 측정이 검색 축 장애로 중단된다
  }

  let answer = '';
  await deps.llmGateway.stream(
    {
      question: args.promptQuestion ?? args.retrievalQuestion,
      evidence: top.map((row, index) => ({
        marker: index + 1,
        content: row.chunk.content,
        guidelineTitle: row.guideline.title,
        sectionPath: row.section.path,
      })),
    },
    (delta) => {
      answer += delta;
    },
  );

  return { answer, top };
}
