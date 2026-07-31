# 27. RAG 평가 기반 — 검색 관측·평가셋 역생성·기준선 측정

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.**

## 목표

RAG 검색의 품질·속도를 **측정 가능한 상태**로 만든다. 지금은 검색 개입(거리 임계값·하이브리드·
리랭커·임베딩 교체)을 하고 싶어도 좋아졌는지 판정할 수단이 없다 — 이 스텝이 끝나면 «평가셋
40문항 → 기준선 지표 → 판정표»의 루프가 성립하고, 이후의 모든 검색 변경은
`retrievalPolicyVersion` 범프 + 평가셋 재실행으로 전후 비교된다.

측정이 개입보다 먼저인 이유 두 가지가 코드에 이미 있다:

1. **`RetrievalService.search()`에 유사도 임계값이 없다.** top-5를 거리와 무관하게 반환하므로,
   근거 0건 abstain 경로(`conversation-stream.service.ts`)는 필터 불일치가 아니면 사실상
   발화하지 않는다 — 범위 밖 질문에도 엉뚱한 근거 5개가 LLM에 넘어간다. 컷 코드는 5분짜리지만
   **컷의 숫자는 거리 분포 없이 못 정한다** (빡빡하면 과잉기권, 느슨하면 무용).
2. **검색 단계가 관측 사각지대다.** `llm_request_duration_seconds`는 있는데 그 앞단(임베딩 호출
   + pgvector 쿼리)의 지연 메트릭이 없고, abstain은 `sse_streams_total{outcome="completed"}`에
   묻혀 정상 답변과 구분되지 않는다. 임베딩 모델 교체 시 재인제스트 전까지 전건 abstain이 되는
   시나리오(docs/specs/14)가 대시보드에 보이지 않는다.

### 판정표 — 기준선이 다음 스텝을 기계적으로 결정한다

| 기준선 관측 | 진단 | 다음 스텝 |
|---|---|---|
| Recall@30 높음, Recall@5 낮음 | 후보군엔 있는데 순서가 나쁨 | 리랭커 (K=30 → rerank → 5) |
| Recall@30도 낮음 + 실패가 용어 불일치 | dense가 정확 매칭을 놓침 | 하이브리드 — 어절 경계 공백이 소실된 코퍼스(docs/specs/19)라 tsvector가 아닌 문자 n-gram(`pg_trgm`/`pg_bigm`) |
| Recall@30도 낮음 + 실패가 의미 불일치 | 임베딩 모델 한계 | 모델 교체 실험 |
| answerable/abstain 거리 분포가 갈림 | 컷 존재 | 거리 임계값 → abstain 연결 |
| Recall 좋은데 답변 품질 나쁨 | 검색 문제 아님 | groundedness(생성) 쪽 |

### 역생성이어도 문항을 확정하는 것은 검수다

역생성 질문은 원본 청크와 어휘를 공유해 **검색이 실제보다 쉬워지는 낙관 편향**이 있다. 생성
프롬프트가 «청크 문장을 그대로 쓰지 말 것»을 지시하고, 검수가 (a) 실제 임상의가 할 법한 표현인가
(b) 청크 표현을 베끼지 않았는가 (c) 라벨 근거가 정말 그 질문의 답인가를 확인해 승격한다.
**검수를 거치지 않은 candidate는 평가에 포함되지 않는다** — 하네스가 스키마 수준에서 강제한다.

### 라벨은 안정 키다 — chunk ID는 재인제스트에 갈린다

재인제스트·재파싱은 chunk ID를 바꾼다(revision 회차, docs/specs/21). 라벨은
`(guidelineTitle, publisher)` (uq_guidelines_title_publisher) + `recommendationNumber`
(권고 청크) 또는 `sectionPath` (비권고)로 기록하고 평가 시점에 DB 조인으로 해석한다.
**해석이 0건이면 그 문항을 건너뛰지 않고 에러로 종료한다** — 조용한 스킵은 라벨 부패를 숨기고
기준선을 낙관 오염시킨다.

## 범위 (진입점)

**신규·변경 엔드포인트 없음. SSE 계약 무변경** — `distance`는 `RetrievedEvidence` 내부 필드로만
추가되고 `toEvidenceDetail`은 그대로다.

| 진입점 | 변경 |
|---|---|
| `metrics.service.ts` | `rag_retrieval_duration_seconds{stage="embed"\|"vector_search"}` · `rag_retrieved_chunks` · `rag_top1_distance` 히스토그램, `rag_answers_total{outcome="answered"\|"abstained"}` 카운터 |
| `retrieval.service.ts` | 단계별 소요·top-1 거리 기록, `RetrievedEvidence`에 `distance` 추가 (SELECT에 포함 — 지금은 정렬에만 쓰고 버린다) |
| `conversation-stream.service.ts` | 답변 결말 기록 — abstain이 `completed`에 묻히지 않게 |
| `scripts/generate-rag-evalset.ts` (신규) | ACTIVE 판본 청크 샘플링 → LLM 역생성 → `.cure-data/rag-evalset-candidates.json` (status `candidate`) |
| `test/fixtures/rag-eval/evalset.json` (신규) | 검수 승격된 평가셋 — repo 커밋, diff가 남는다 |
| `scripts/eval-rag.ts` (신규) | 평가셋 실행 → Recall@5 · MRR@5 · Recall@30 · 거리 분포 → 마크다운 리포트 (stdout) |
| `docker/gcp/monitoring/grafana/.../application.json` | RAG 행 — 임베딩/벡터검색/LLM 지연 스택 · abstain율 · top-1 거리 추이 |
| `package.json` | `evalset:generate` · `eval:rag` 스크립트 |

- **역생성 스크립트는 서빙 LLM 포트를 재사용하지 않는다.** `LlmProvider.streamAnswer`는 근거
  인용 답변 전용 계약이고, 오프라인 스크립트는 4단 방어(§11)가 필요 없다 — 실패의 복구는
  재실행이다. 스크립트가 직접 호출한다.
- **샘플링 다양성**: 지침별 상한을 두어 특정 지침 편중을 막고, `recommendationNumber` 있는
  청크를 우선한다. abstain 후보는 코퍼스 지침 제목 목록을 주고 «목록이 다루지 않는 인접 임상
  질문»을 생성한다. candidate 파일에는 생성 근거(원본 청크 발췌)를 실어 검수자가 대조한다.
- **평가셋 목표 규모**: answerable ~25 + abstain ~15. 규모는 데이터 작업이라 수용 기준이 아니다.
- **`eval-rag.ts` 측정**: answerable은 K=30으로 검색해 Recall@5·MRR@5·Recall@30(진단용 상한),
  abstain은 top-1 거리만. 리포트에 실패 문항 목록, 거리 분포(kind별 p10/p50/p90),
  `retrievalPolicyVersion`·청크 수를 싣는다 — PR에 전후 비교표로 붙는 산출물이다.
- 평가셋 항목 스키마: `{ id, kind: 'answerable'|'abstain', question, expectedEvidence:
  [{ guidelineTitle, publisher, recommendationNumber? , sectionPath? }], status:
  'candidate'|'approved'|'rejected', origin: 'reverse-generated'|'manual' }`. abstain은
  `expectedEvidence: []`.

## Entity / 마이그레이션 변경분

없음.

## 추가 에러코드

없음 — 스크립트·메트릭 계층뿐이다.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

1. 대화 스트림이 정상 답변으로 끝나면 `/metrics`에 `rag_answers_total{outcome="answered"}`가,
   근거 0건 abstain으로 끝나면 `{outcome="abstained"}`가 증가한다 — 두 경로 모두
   `sse_streams_total{outcome="completed"}`이며, abstain 여부는 이 축에서만 갈린다.
2. 검색 1회 후 `/metrics`에 `rag_retrieval_duration_seconds{stage="embed"}` ·
   `{stage="vector_search"}` · `rag_retrieved_chunks` · `rag_top1_distance` 관측치가 남는다.
3. 평가셋 로더는 `status: 'approved'` 항목만 평가에 포함하고, 스키마 위반(안정 키 결손,
   answerable인데 `expectedEvidence` 빈 배열)은 에러로 거부한다.
4. 라벨 해석 실패(승인 문항의 안정 키가 코퍼스에 0건 매칭)는 해당 문항 스킵이 아니라 **비영
   종료**다 — 에러 메시지에 실패 문항 id와 키를 싣는다.
5. `eval-rag.ts`가 테스트 코퍼스(fixture 인제스트 + fake 임베딩) 위에서 결정적으로
   Recall@5 · MRR@5 · Recall@30을 산출하고, 마크다운 리포트에 지표 요약·실패 문항·kind별 거리
   분포·`retrievalPolicyVersion`을 포함한다.

## Out of scope

- **거리 임계값의 런타임 적용** — 기준선 분포가 숫자를 준 뒤의 다음 스텝이다.
- 하이브리드·리랭커·임베딩 모델 교체 — 판정표가 지시할 때, 한 번에 하나씩.
- HNSW 인덱스 — 87건 코퍼스에서 exact search는 ms대다. 측정(§12)이 필요를 보이면.
- groundedness(LLM-as-judge) 생성 품질 평가 — 검색 품질이 상한이므로 검색부터.
- 사용자 피드백(👍/👎) API·관리자 평가 FE — 임상의 검수를 붙이는 시점의 오답 리뷰 큐로.
- 역생성 스크립트 자체의 e2e — LLM 의존 오프라인 도구다. 계약 경계는 산출물이 통과해야 하는
  평가셋 스키마(수용 기준 3)이며, 그 문항이 평가에 들어가는 관문은 사람 검수다.
