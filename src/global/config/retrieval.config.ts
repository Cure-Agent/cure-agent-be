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
}));

/** TODO(docs/specs/28 기준 7): 미지정·빈 값은 코드 기본값 0.42로 (compose 빈 통과 규약) */
function parseCutoff(_raw: string | undefined): number {
  return Number.NaN;
}
