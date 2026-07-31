/**
 * 평가셋 역생성 CLI (docs/specs/27).
 * 사용법: `pnpm evalset:generate` → .cure-data/rag-evalset-candidates.json
 *
 * 산출물은 전부 `status: 'candidate'`다 — 사람 검수를 거쳐 `approved`로 승격된 것만
 * test/fixtures/rag-eval/evalset.json에 들어가고, 로더가 그것만 평가에 넣는다.
 *
 * 서빙 LLM 포트(LlmProvider.streamAnswer)를 재사용하지 않는다 — 근거 인용 답변 전용 계약이고,
 * 오프라인 도구에 §11 4단 방어는 불필요하다(실패의 복구는 재실행이다).
 */

const OUTPUT = '.cure-data/rag-evalset-candidates.json';

async function main(): Promise<void> {
  // TODO(docs/specs/27): ACTIVE 판본 청크를 지침별 상한으로 샘플링 → 질문 역생성 →
  //   생성 근거(원본 청크 발췌)와 함께 candidate로 기록. abstain 후보는 코퍼스 지침 제목
  //   목록을 주고 「목록이 다루지 않는 인접 임상 질문」을 생성한다.
  await Promise.resolve();
  throw new Error(`TODO: docs/specs/27 역생성 미구현 (출력 예정 경로: ${OUTPUT})`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
