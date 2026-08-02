import { registerAs } from '@nestjs/config';

/**
 * 검색 거리 임계값 설정 (docs/specs/28, 기본값 개정 2026-08-02).
 *
 * **기본값은 이 파일이 단독으로 소유한다** — compose는 `${VAR:-}`로 빈 값을 통과시킬 뿐이다.
 * 두 곳이 기본값을 가지면 코드 상향이 조용히 무효가 된다(#156 실증: LLM_MAX_OUTPUT_TOKENS).
 *
 * 0.48인 근거는 paraphrase 실측(docs/rag-eval/2026-08-02-*)이다. spec 28의 0.42는 긴 임상
 * 문장 59문항에서 손실 0이었지만 max(0.4167)와 여유가 0.0033뿐이었고, 축약 문체에서
 * answerable 4/59가 컷을 넘어 리랭커에 닿기 전에 기권됐다(축약 max 0.4358). 0.48은 두 문체
 * 합산 118문항 손실 0 + 여유 0.044이며, abstain 27%는 여전히 거리에서 선컷돼 리랭크 비용을
 * 아낀다. 기권 재현은 리랭크 점수 게이트가 담당한다(docs/specs/29, 실측 0.933).
 */
export const retrievalConfig = registerAs('retrieval', () => ({
  distanceCutoff: parseCutoff(process.env.RETRIEVAL_DISTANCE_CUTOFF),
  /**
   * LLM 리랭크 (docs/specs/29). 기본 켜짐 — 끄면 §28 동작(코사인 top-5 + 거리 게이트)이다.
   * candidates 30은 프로덕션 74문항 실측값이다 (K=30에서 Recall@30 0.983).
   *
   * **scoreCutoff 9로 상향 (issue #232, 2026-08-02).** spec 29의 6은 「answerable min 8 /
   * 거리 통과 abstain max 4의 중앙」이었는데 그 근거는 abstain 15문항 기준이었다. abstain을
   * 44문항으로 늘리자(#228) 어려운 인접 질문이 6~8점 구간을 채워 전제가 무너졌고, 컷 6이
   * abstain 덩어리 한가운데 놓이면서 기권 실패 8건이 전부 6~8점에서 샜다.
   *
   * 점수 분포는 사실 잘 분리돼 있다 (프로덕션 코퍼스 · answerable 185 / abstain 44):
   * answerable 183/185가 9~10점, abstain은 9점 이상이 4건뿐이다. 컷을 9로 옮기면
   * 기권 재현율 0.773 → **0.977**, 대가는 과잉 기권 0.000 → 0.011(2문항)·리랭크
   * Recall@5 0.962 → 0.951이다 — 위험한 답변 9건을 막고 정상 질문 2건을 기권하는 교환이라
   * 안전 축에서 받는다. 프롬프트로 점수 척도를 고치는 시도는 효과가 없었다(측정 후 폐기).
   */
  rerankEnabled: process.env.RETRIEVAL_RERANK_ENABLED !== 'false',
  rerankCandidates: parsePositive(process.env.RETRIEVAL_RERANK_CANDIDATES, 30),
  rerankScoreCutoff: parsePositive(process.env.RETRIEVAL_RERANK_SCORE_CUTOFF, 9),
  /** 하이브리드 검색 (docs/specs/31) — 스텁 자리다. env 규약은 구현이 채운다 */
  hybridEnabled: false,
}));

const DEFAULT_DISTANCE_CUTOFF = 0.48;

/** 미지정·빈 값·수가 아닌 값은 전부 코드 기본값으로 떨어진다 (compose 빈 통과 규약) */
function parseCutoff(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DISTANCE_CUTOFF;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DISTANCE_CUTOFF;
}

/** 같은 규약의 양수 파서 — 리랭크 후보 수·점수 컷용 */
function parsePositive(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
