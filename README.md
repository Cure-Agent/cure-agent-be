# cure-agent-be

한의사용 임상 어시스턴트 CureAgent의 백엔드. 지침 근거 검색(RAG)·SSE 스트리밍 답변·환자 스냅샷 기반
임상 가이던스·의료인 검토를 제공한다. **설계 단일 원본은 [docs/architecture.md](docs/architecture.md)**,
스텝별 스펙은 [docs/specs/](docs/specs/)를 본다.

## 스택

NestJS 11 · Drizzle ORM + PostgreSQL(pgvector, exact search) · Redis(denylist, fail-open) ·
SSE 스트리밍(§8) · OpenAPI 계약 파이프라인(§1) · jest + Testcontainers e2e

## 구동

```bash
pnpm install
docker compose up -d          # pgvector + redis (.env.example의 DATABASE_URL과 일치)
cp .env.example .env          # 키 값 채우기 (openssl rand -base64 32/48)
pnpm db:migrate               # drizzle 마이그레이션
pnpm start:dev                # http://localhost:3000/api/v1

pnpm lint && pnpm test        # 유닛
pnpm test:e2e                 # e2e (Docker 필요 — Testcontainers, 직렬 실행)
```

LLM·임베딩 API 키(`OPENAI_API_KEY`·`ANTHROPIC_API_KEY`)가 없으면 결정적 fake 프로바이더로
동작한다 — **키 없이 전 구간 구동·검증 가능**하다(로컬·CI 기본값, docs/specs/13·14).

## 개발 방식 (SDD)

스텝당 1페이지 스펙([docs/specs/](docs/specs/)) → 수용 기준 e2e를 **구현 전 작성·동결**(테스트는
Codex가 스펙에서 독립 파생, Claude가 리뷰·동결·구현 — 심판과 선수를 같은 에이전트가 만들지 않는다)
→ 동결 테스트를 통과시키는 구현 → dev PR부터 프로덕션 CD까지 자동 배포. "구현 중 테스트 수정 금지"는
규율이 아니라 **훅(예방)과 사후 감사(탐지)로 기계적으로 강제**된다.

전체 구조·강제 장치·실제 추적 사례는 **[docs/sdd.md](docs/sdd.md)**를 본다.
