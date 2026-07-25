# 14. 실 임베딩 프로바이더 + 검색 출처 일치 보장

> spec 13(실 LLM)의 직후 스텝. 실 LLM만 붙은 상태에서는 retrieval이 여전히 결정적 fake 해시 벡터라
> **의미 없는 근거 위에서 그럴듯한 답**이 나온다. API 계약(OpenAPI) 무변경 — FE 파장 0.

## 목표

질문·근거 임베딩을 실제 의미 벡터(OpenAI)로 생성한다. 동시에 **서로 다른 임베딩 모델로 만들어진 벡터가
한 검색에 섞이지 않도록** 보장한다 — 모델을 바꾸면 기존 벡터는 좌표계가 달라 무의미하지만, 코사인 거리는
그래도 "가장 가까운 5건"을 조용히 돌려주기 때문이다. 키가 없으면 기존 fake 단독 동작이 그대로 보존된다.

## 범위

| 대상 | 변경 |
|---|---|
| API 엔드포인트 | **없음** (계약 무변경) |
| `infrastructure/embedding/` | 신규 `embedding.config.ts`, `openai-embedding.provider.ts`, `embedding-provider.factory.ts` / `embedding.module.ts` 등록 정책 변경 |
| 포트 | `EmbeddingProvider.model: string` 추가(외부 구현자 없음 — 필수 필드), `EmbeddingProviderError` 신설 |
| 마이그레이션 | `0005`: `evidence_chunks.embedding_model text NOT NULL DEFAULT 'fake-embedding-v1'` (기존 행은 실제로 fake 산출물이므로 기본값이 정확하다) |
| 인제스트 | 청크 저장 시 현재 프로바이더의 `model` 기록 |
| 검색 | `embedding_model = <현재 모델>` 필터. `RetrievalService.policyVersion` = `cosine-exact-top5-v1/<모델>`로 GenerationRun에 기록 |

- HTTP는 spec 13의 `provider-http`(연결 타임아웃·오류 등급화)를 재사용한다. 신규 의존성 0.
- 임베딩은 §11 4단 방어(게이트웨이) 경로가 아니다 — 실패는 호출자(인제스트 CLI·스트림)로 그대로 전파된다.

## env (선택 — `OPENAI_API_KEY`·`OPENAI_BASE_URL`은 spec 13과 공유)

| 키 | 기본값 |
|---|---|
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` (1536차원 — 스키마 `EMBEDDING_DIMENSIONS`와 정합) |

`OPENAI_API_KEY`가 없으면 fake 임베딩 단독(로컬·CI 기본값). Anthropic은 임베딩 API가 없어 대상이 아니다.

## 수용 기준 (= 동결 시나리오, Definition of Done)

**유닛 (fetch 목)**

1. `POST {baseUrl}/embeddings` + `Authorization: Bearer` + 본문에 `model`·`input`(입력 배열)·`dimensions: 1536`.
   응답 `data`가 **뒤섞인 index 순서로 와도** `index` 오름차순으로 정렬해 입력 순서와 일치하는 벡터 배열을 반환한다
2. **배치 분할**: 입력 100개 → 96 + 4로 두 번 호출하고, 결과는 입력 순서 그대로 100개다
3. **오류 매핑**: 429 + `Retry-After: 30` → `EmbeddingProviderError`(`rateLimited=true`, `retryAfterSec=30`) /
   500 → `retryable=true` / 401 → `retryable=false`
4. **차원 검증**: 응답 벡터 길이가 1536이 아니면 `EmbeddingProviderError`를 던진다
   (조용히 저장되면 pgvector insert가 깨지거나 잘못된 좌표계가 영속화된다)
5. **등록 정책**: `OPENAI_API_KEY` 없음 → `fake-embedding-v1` / 있음 → `text-embedding-3-small`(fake 미포함)

**e2e (Testcontainers)**

6. 인제스트로 근거를 넣고 질문 스트림이 정상 답변(인용 ≥ 1)함을 확인한 뒤,
   `UPDATE evidence_chunks SET embedding_model = 'legacy-model'` → 같은 질문 → **`answer.abstained`**(근거 0건),
   원복하면 다시 정상 답변. 즉 **출처가 다른 벡터는 검색에서 제외**된다

## 테스트 전략 (동결 범위)

- 실 어댑터는 API 키 없이 CI에서 돌아야 하므로 유닛(fetch 목)으로 동결한다(spec 13과 동일 사유).
- 기준 6은 DB 상태가 본질이라 e2e로 동결한다 — 기존 06 동결 e2e는 출처 필터를 모르므로 중복이 아니다.
- Codex 교차 작성 유지.

## Out of scope

- Anthropic 임베딩(제공 안 함), 임베딩 결과 캐시, HNSW/IVFFlat 인덱스(§12 — 측정 후), 재인제스트 자동화·마이그레이션 스크립트
- 검색 시 최신 버전만 보기(현재는 전 버전 청크가 경쟁 — 기존 동작 유지)
- 알림 채널 다중화·배포 인프라(백로그 잔여)
