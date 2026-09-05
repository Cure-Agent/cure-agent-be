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
   *
   * **위 근거는 벡터 단독 검색(§29) 표본이다 — 하이브리드(§31) 배포로 전제가 바뀌었다.**
   * 재측정(docs/rag-eval/2026-08-02-hybrid-retrieval.md, 같은 코퍼스·같은 229문항):
   * 후보군이 넓어지자 **양쪽 분포가 함께 위로 밀렸다**. answerable은 9점 7건·10점 177건으로
   * 더 좋아졌지만, abstain의 9점 이상이 3건 → 6건이 되며 기권 재현율이 0.977 → **0.909**로
   * 떨어졌다(실패 1건 → 4건). 어휘가 겹치는 오답 후보가 리랭커에 더 많이 닿은 결과다.
   *
   * **그럼에도 컷은 9를 유지한다 (2026-08-02 사용자 확정, issue #246).** 컷 10이면 재현율은
   * 0.977로 복귀하지만 ⑴ 척도 최상단이라 LLM 점수의 실행 간 변동에 여유가 **0**이고
   * ⑵ 교환비가 3건 차단 대 7건 과잉 기권으로, #232가 안전 축에서 받아들인 9:2보다 나쁘다.
   * ⑶ 오답 지침은 인용으로 임상의에게 그대로 보인다. 컷을 다시 볼 때는 리포트의 점수
   * 히스토그램을 먼저 본다(#232 규약) — **그리고 그 히스토그램이 어느 검색 정책에서
   * 나왔는지 확인한다.** 이 문단이 존재하는 이유가 그것이다.
   */
  rerankEnabled: process.env.RETRIEVAL_RERANK_ENABLED !== 'false',
  rerankCandidates: parsePositive(process.env.RETRIEVAL_RERANK_CANDIDATES, 30),
  rerankScoreCutoff: parsePositive(process.env.RETRIEVAL_RERANK_SCORE_CUTOFF, 9),
  /**
   * 하이브리드 검색 (docs/specs/31). 기본 켜짐 — 끄면 §29 동작(벡터 top-K + 리랭크)이다.
   *
   * 벡터 단독 후보군이 리랭커의 상한이었다: prod 코퍼스 실측(7,154청크 × answerable 185)에서
   * Recall@30 0.968이라 후보에조차 못 든 6문항은 리랭커가 손댈 수 없었다. 문자 n-gram
   * 키워드 arm과의 RRF 합집합은 후보 커버리지 **1.000**, 리랭크 Recall@5 0.962 → 0.973이다.
   *
   * arm당 K는 `rerankCandidates`를 그대로 쓴다 — 후보군 크기 손잡이가 둘이면 동기화 사고가 난다.
   */
  hybridEnabled: process.env.RETRIEVAL_HYBRID_ENABLED !== 'false',
  /** 어휘 프리필터 (docs/specs/45) — 스텁. 구현에서 env 파싱·기본값으로 대체한다 */
  vocabPrefilterEnabled: false,
  /** 어휘 프리필터 DF 컷 비율 (docs/specs/45) — 스텁 */
  vocabCommonDfRatio: 0,
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
