import { registerAs } from '@nestjs/config';

/**
 * 검색 거리 임계값 설정 (docs/specs/28).
 *
 * **기본값 0.42는 이 파일이 단독으로 소유한다** — compose는 `${VAR:-}`로 빈 값을 통과시킬 뿐이다.
 * 두 곳이 기본값을 가지면 코드 상향이 조용히 무효가 된다(#156 실증: LLM_MAX_OUTPUT_TOKENS).
 *
 * 0.42인 근거는 spec 28 실측이다: 프로덕션 74문항 raw 거리 스윕에서 **정답 손실 0이 증명된
 * 유일한 유효값**(기권 재현 9/15). answerable max(0.4167)와의 여유가 0.0033뿐이라 표본 밖
 * 추상 질문이 넘을 수 있다 — 그래서 env 조정 가능이 필수이고, 리랭커 후 재측정이 교정 지점이다.
 */
export const retrievalConfig = registerAs('retrieval', () => ({
  distanceCutoff: parseCutoff(process.env.RETRIEVAL_DISTANCE_CUTOFF),
  /**
   * LLM 리랭크 (docs/specs/29). 기본 켜짐 — 끄면 §28 동작(코사인 top-5 + 거리 게이트)이다.
   * candidates 30·scoreCutoff 6은 프로덕션 74문항 실측값이다: K=30에서 Recall@30 0.983,
   * 점수 컷 6은 answerable min 8 / 거리 통과 abstain max 4 사이의 중앙(양쪽 마진 2점).
   */
  rerankEnabled: process.env.RETRIEVAL_RERANK_ENABLED !== 'false',
  rerankCandidates: parsePositive(process.env.RETRIEVAL_RERANK_CANDIDATES, 30),
  rerankScoreCutoff: parsePositive(process.env.RETRIEVAL_RERANK_SCORE_CUTOFF, 6),
}));

const DEFAULT_DISTANCE_CUTOFF = 0.42;

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
