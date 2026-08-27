# CureAgent Backend

English | [한국어](README.ko.md)

> A production-oriented clinical RAG backend for evidence-grounded Korean medicine decision support.

CureAgent turns 87 clinical-guideline PDFs into 7,154 searchable evidence chunks, retrieves and
reranks the most relevant passages, and streams answers with source-linked citations. Its safety
path is evaluated against 229 questions—including 44 deliberately unanswerable cases—and abstains
when the available evidence cannot support an answer. The system also includes multi-provider LLM
routing, production observability, and failure recovery.

[Live Demo](https://cure.demo01.xyz/assistant) ·
[Frontend](https://github.com/Cure-Agent/cure-agent-fe) ·
[OpenAPI Contract](openapi/cure-agent.v1.json)

## Key Features

- **Hybrid retrieval** — runs pgvector cosine search and `pg_trgm` character n-gram search in
  parallel, fuses both arms with Reciprocal Rank Fusion, and applies LLM reranking.
- **Citation-grounded generation** — constrains answers to retrieved guideline evidence and maps
  inline `[n]` markers to the source URL, section path, and supporting quote.
- **Layered abstention and safety gates** — combines a vector-distance gate, reranker relevance
  cutoff, and generation-stage answerability verdict instead of forcing an unsupported answer.
- **229-question evaluation suite** — measures retrieval, reranking, abstention, and claim-level
  groundedness across 185 answerable and 44 out-of-scope questions.
- **Multi-provider LLM routing** — routes across OpenAI and Anthropic with retries, rate-limit
  cooldowns, circuit breakers, and pre-stream fallback; deterministic fake providers support local
  development and CI.
- **SSE streaming** — exposes typed retrieval, answer-delta, completion, abstention, and error events
  with sequence numbers and heartbeats.
- **Observability and resilience** — provides Prometheus metrics for HTTP, retrieval, reranking, LLM,
  and SSE stages, request trace IDs, and deduplicated Slack/Discord webhook alerts.

## Architecture

```text
User → Hybrid Retrieval → LLM Reranking → Grounded LLM → Citation / Abstention → SSE
```

The backend is a domain-oriented NestJS modular monolith backed by PostgreSQL and Redis. See the
[architecture document](docs/architecture.md) for the complete system design and
[step specifications](docs/specs/) for implementation-level decisions. These documents remain the
source of truth; the README intentionally stays at system-overview level.

## Tech Stack

NestJS 11 · TypeScript 5 · Drizzle ORM · PostgreSQL 17 (`pgvector` exact cosine search + `pg_trgm`) ·
Redis 7 · SSE · OpenAPI · Prometheus · Jest + Testcontainers · Docker

## Evaluation

The offline evaluation uses a production-corpus snapshot rather than synthetic retrieval fixtures.

| Scope                                  |                Size |
| -------------------------------------- | ------------------: |
| Clinical-guideline source documents    |             87 PDFs |
| Indexed evidence corpus                | 7,154 active chunks |
| Evaluation questions                   |           229 total |
| Answerable / expected-abstention split |            185 / 44 |

Representative results:

| Metric                    | Result |
| ------------------------- | -----: |
| Hybrid candidate coverage | 100.0% |
| Reranked Recall@5         |  97.3% |
| Reranked MRR@5            |  0.925 |
| Abstention recall         |  93.2% |
| Over-abstention rate      |   0.0% |
| Claim-level support rate  |  91.8% |

Retrieval and abstention results come from the
[2026-08-25 policy run](docs/rag-eval/2026-08-25-cut-sweep-run2.md); claim support comes from the
[qa-v5 groundedness run](docs/rag-eval/2026-08-03-groundedness-qa-v5.md). The 229-question set also
informed cutoff selection, so these are diagnostic policy metrics—not an independent held-out
generalization benchmark. See [all evaluation reports](docs/rag-eval/) for prompts, failure cases,
distribution sweeps, and limitations.

## Getting Started

Prerequisites: Node.js 22+, pnpm 10+, and Docker.

```bash
pnpm install
cp .env.example .env          # Configure required secrets and at least one OAuth provider
docker compose up -d          # PostgreSQL + pgvector and Redis
pnpm db:migrate               # Apply Drizzle migrations
pnpm start:dev                # API: http://localhost:3000/api/v1
                              # Swagger: http://localhost:3000/api/docs
```

Run the verification suites:

```bash
pnpm lint && pnpm test        # Lint and unit tests
pnpm test:e2e                 # Testcontainers e2e; Docker required
```

`OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are optional. Without them, deterministic fake LLM,
embedding, reranking, and guidance providers keep local and CI flows testable. Authentication still
requires at least one configured Google, Kakao, or Naver OAuth client ID; see
[`.env.example`](.env.example) for every setting.

## Specification-Driven Development

Each increment starts with a one-page [specification](docs/specs/). Acceptance e2e tests are derived
independently before implementation, reviewed, and frozen; implementation must satisfy them without
changing the test oracle. Hooks prevent edits to frozen tests, while a commit-based diff audit catches
bypass attempts. The delivery pipeline then automates the path from dev PR and CI through the
production deployment PR and CD.

See [Specification-Driven Development](docs/sdd.md) for the enforcement model, automation harness,
and a traceable production example.
