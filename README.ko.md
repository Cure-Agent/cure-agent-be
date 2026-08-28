# CureAgent Backend

[English](README.md) | 한국어

> 근거 기반 한의 임상 의사결정을 지원하는 프로덕션 지향 임상 RAG 백엔드.

CureAgent는 임상지침 PDF 87개를 검색 가능한 근거 청크 7,154개로 변환하고, 가장 관련성 높은
근거를 검색·리랭크해 출처가 연결된 인용과 함께 답변을 스트리밍한다. 안전 경로는 의도적으로 답할 수
없게 구성한 44개를 포함해 총 229개 질문으로 평가하며, 주어진 근거로 답변을 뒷받침할 수 없으면
기권한다. 또한 다중 LLM 프로바이더 라우팅, 프로덕션 관측성, 장애 복구 체계를 갖추고 있다.

[라이브 데모](https://cure.demo01.xyz/assistant) ·
[프론트엔드](https://github.com/Cure-Agent/cure-agent-fe) ·
[OpenAPI 계약](openapi/cure-agent.v1.json)

## 핵심 기능

- **하이브리드 검색** — pgvector 코사인 검색과 `pg_trgm` 문자 n-gram 검색을 병렬로 실행하고,
  Reciprocal Rank Fusion으로 두 결과를 합친 뒤 LLM 리랭크를 적용한다.
- **인용 근거 기반 생성** — 답변을 검색된 지침 근거로 제한하고, 본문의 `[n]` 마커를 원문
  URL·섹션 경로·뒷받침 인용문과 연결한다.
- **다층 기권·안전 게이트** — 벡터 거리 게이트, 리랭커 관련도 컷, 생성 단계의 답변가능성 판정을
  결합해 근거 없는 답변을 억지로 생성하지 않는다.
- **229문항 평가 스위트** — 답변 가능 185문항과 범위 밖 44문항으로 검색·리랭크·기권·주장 단위
  근거성을 측정한다.
- **다중 LLM 프로바이더 라우팅** — OpenAI와 Anthropic 사이를 라우팅하며 재시도, 요청 한도 쿨다운,
  서킷 브레이커, 스트리밍 전 폴백을 적용한다. 결정적 fake 프로바이더로 로컬 개발과 CI도 지원한다.
- **SSE 스트리밍** — 순번과 하트비트를 갖춘 검색·답변 delta·완료·기권·오류 이벤트를 명시적인
  타입으로 제공한다.
- **관측성·회복탄력성** — HTTP·검색·리랭크·LLM·SSE 단계별 Prometheus 메트릭, 요청 trace ID,
  중복 억제를 적용한 Slack/Discord 웹훅 알림을 제공한다.

## 아키텍처

```text
사용자 → 하이브리드 검색 → LLM 리랭크 → 근거 기반 LLM → 인용 / 기권 → SSE
```

백엔드는 PostgreSQL과 Redis를 사용하는 도메인 중심 NestJS 모듈러 모놀리스로 구성된다. 전체 시스템
설계는 [아키텍처 문서](docs/architecture.md), 구현 단위의 의사결정은 [단계별 스펙](docs/specs/)을 참고한다.
이 문서들이 설계의 단일 원본이며, README는 의도적으로 시스템 개요 수준을 유지한다.

## 기술 스택

NestJS 11 · TypeScript 5 · Drizzle ORM · PostgreSQL 17 (`pgvector` 정확 코사인 검색 + `pg_trgm`) ·
Redis 7 · SSE · OpenAPI · Prometheus · Jest + Testcontainers · Docker

## 평가

오프라인 평가는 합성 검색 fixture가 아니라 프로덕션 코퍼스 스냅샷을 사용한다.

| 범위                       |              규모 |
| -------------------------- | ----------------: |
| 임상지침 원문              |          PDF 87개 |
| 인덱싱된 근거 코퍼스       | 활성 청크 7,154개 |
| 평가 질문                  |          총 229개 |
| 답변 가능 / 기권 기대 문항 |          185 / 44 |

대표 결과:

| 지표                     |   결과 |
| ------------------------ | -----: |
| 하이브리드 후보 커버리지 | 100.0% |
| 리랭크 Recall@5          |  97.3% |
| 리랭크 MRR@5             |  0.925 |
| 기권 재현율              |  93.2% |
| 과잉 기권율              |   0.0% |
| 주장 단위 근거 지지율    |  91.8% |

검색과 기권 결과는 [2026-08-25 정책 실행](docs/rag-eval/2026-08-25-cut-sweep-run2.md), 주장 지지율은
[qa-v5 근거성 평가](docs/rag-eval/2026-08-03-groundedness-qa-v5.md)에서 가져왔다. 229문항 평가셋은 컷오프
선정에도 사용됐으므로, 이 결과는 독립 held-out 일반화 벤치마크가 아니라 정책 진단 지표다. 프롬프트,
실패 사례, 분포 스윕, 평가 한계는 [전체 평가 리포트](docs/rag-eval/)를 참고한다.

## 시작하기

필요 환경: Node.js 22 이상, pnpm 10 이상, Docker.

```bash
pnpm install
cp .env.example .env          # 필수 secret과 OAuth 프로바이더 하나 이상 설정
docker compose up -d          # PostgreSQL + pgvector, Redis
pnpm db:migrate               # Drizzle 마이그레이션 적용
pnpm start:dev                # API: http://localhost:3000/api/v1
                              # Swagger: http://localhost:3000/api/docs
```

검증 스위트를 실행한다.

```bash
pnpm lint && pnpm test        # 린트와 유닛 테스트
pnpm test:e2e                 # Testcontainers e2e; Docker 필요
```

`OPENAI_API_KEY`와 `ANTHROPIC_API_KEY`는 선택 설정이다. 키가 없으면 결정적 fake LLM·임베딩·리랭킹·
가이던스 프로바이더로 로컬과 CI 흐름을 검증할 수 있다. 인증을 사용하려면 Google·Kakao·Naver 중 하나 이상의
OAuth client ID가 필요하다. 전체 설정은 [`.env.example`](.env.example)을 참고한다.

## 스펙 주도 개발

각 단계는 1페이지 [스펙](docs/specs/)으로 시작한다. 수용 기준 e2e 테스트는 구현 전에 독립적으로 파생해 리뷰하고
동결하며, 구현은 테스트 오라클을 바꾸지 않고 이를 통과해야 한다. 훅이 동결 테스트 편집을 예방하고,
커밋 기반 diff 감사가 우회 시도를 탐지한다. 이후 배포 파이프라인이 dev PR과 CI에서 프로덕션 배포 PR과 CD까지의
흐름을 자동화한다.

강제 모델, 자동화 하네스, 실제 프로덕션 추적 사례는 [스펙 주도 개발](docs/sdd.ko.md)을 참고한다.
