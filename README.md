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
```

## LLM 프로바이더 (docs/specs/13)

`.env`에 `OPENAI_API_KEY`·`ANTHROPIC_API_KEY`를 넣으면 해당 실 프로바이더가 우선순위(openai → anthropic)로
등록되고, 하나도 없으면 결정적 fake 단독으로 동작한다(로컬·CI 기본값 — 키 없이 전 구간 검증 가능).
실 프로바이더가 등록되면 fake는 폴백에서 빠진다: 전 프로바이더 실패는 fake 답변이 아니라
503 `LLM_UNAVAILABLE`이어야 하기 때문이다. 재시도·서킷브레이커·rate-limit 차단·우선순위 폴백은 §11 참조.

## 검증

```bash
pnpm lint && pnpm test        # 유닛
pnpm test:e2e                 # e2e (Docker 필요 — Testcontainers, 직렬 실행)
pnpm build
```

## 계약 파이프라인 (§1)

DTO·컨트롤러 변경 → `pnpm openapi:export`로 `openapi/cure-agent.v1.json` 재생성 후 커밋.
CI가 "커밋본 = 재생성본"(contract)과 breaking 여부(oasdiff)를 검사하고, main 머지 시
repository_dispatch로 cure-agent-fe에 타입 동기화 PR이 자동 생성된다.

## 개발 방식 (SDD)

스텝당 1페이지 스펙(docs/specs) → 수용 기준 e2e를 **구현 전 작성·동결**(Codex 작성/Claude 리뷰·구현,
`.claude/commands/implement.md`) → 구현은 동결 테스트를 통과시키는 방식. 구현 중 테스트 수정 금지.
