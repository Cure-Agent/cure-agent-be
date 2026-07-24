# 13. 실 LLM 프로바이더 연동 (OpenAI · Anthropic)

> 6단계(spec 06)에서 "후속 spec 07"로 미뤘던 항목이다. 07 번호는 FE 파운데이션이 사용했으므로 **이 스펙(13)이 그 후속**이다.
> API 계약(OpenAPI) 무변경 — FE 파장 0.

## 목표

API 키가 설정된 환경에서 실 LLM(OpenAI·Anthropic)이 §11 게이트웨이를 통해 답변을 스트리밍한다.
키가 하나도 없으면 **현행 fake 단독 동작이 그대로 보존**되어, CI·로컬은 키 없이 계속 전 구간 검증 가능하다.

## 범위

| 대상 | 변경 |
|---|---|
| API 엔드포인트 | **없음** (계약 무변경, `openapi:export` diff 0) |
| `infrastructure/llm/` | 신규 `llm.config.ts`, `prompt-builder.ts`, `sse-stream.parser.ts`, `openai.provider.ts`, `anthropic.provider.ts` / `llm.module.ts` 등록 정책 변경 |
| 포트 | `LlmProvider.model?`·`LlmStreamOutcome.model?` **선택 필드로만** 확장 (동결 e2e의 인라인 프로바이더 호환 유지) |
| GenerationRun | `model` = 실사용 모델(`outcome.model`), 미제공 프로바이더는 기존 `gateway-routed` 유지. `PROMPT_VERSION`은 실 프롬프트 도입에 맞춰 `qa-v2`로 상향 |

- HTTP 클라이언트는 **Node 내장 `fetch`**만 사용한다(신규 의존성 0 — §3 경량화). 벤더 SDK는 자체 재시도를 내장해 §11의 4단 방어와 이중화되므로 쓰지 않는다.

## 등록 정책 (핵심 결정)

1. `OPENAI_API_KEY` 있으면 openai 등록, `ANTHROPIC_API_KEY` 있으면 anthropic 등록. 우선순위 = **openai → anthropic**
2. **실 프로바이더가 하나라도 등록되면 fake는 배열에 넣지 않는다.** 임상 의사결정 참고 도구에서 "전 프로바이더 실패 시 fake 답변이 진짜 답변처럼 의료인에게 노출"되는 것은 503(`LLM_UNAVAILABLE`)보다 위험하다. 실 등록 0개일 때만 `[fake]`(= 현행 동작).

## env (전부 선택 — `env.validation` 필수화 금지)

| 키 | 기본값 | 비고 |
|---|---|---|
| `OPENAI_API_KEY` | – | 없으면 openai 미등록 |
| `OPENAI_MODEL` | `gpt-5.1` | 프로바이더 문서 기준으로 갱신 가능 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | 프록시·게이트웨이 대응 |
| `ANTHROPIC_API_KEY` | – | 없으면 anthropic 미등록 |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com/v1` | |
| `LLM_MAX_OUTPUT_TOKENS` | `1024` | 공통 |

`.env.example`·`README.md`를 같은 커밋에서 갱신한다.

## 오류 매핑 (§11 4단 방어가 소비하는 계약)

- `429` → `LlmProviderError(rateLimited: true, retryAfterSec: Retry-After 헤더 정수)` — 헤더 없거나 파싱 불가면 `retryAfterSec` 미지정
- `5xx`·네트워크 오류·연결 타임아웃(10s, 응답 헤더 수신까지) → `retryable: true`
- 그 외 `4xx`(401·403·400 등 설정 오류) → `retryable: false`
- **abort는 `LlmProviderError`로 감싸지 않고 원 오류 그대로 전파** — 게이트웨이는 `signal.aborted`로 폴백을 차단하고 스트림 서비스는 `CANCELLED`로 정리한다(§8-4)
- 전체 상한(120s)은 호출측(`conversation-stream.service`)이 이미 부여하므로 어댑터는 연결 타임아웃만 책임진다

## 인용 계약

프롬프트는 근거를 `[n]` 마커와 함께 제시하고 **인용 시 `[n]` 표기를 지시**한다(§8·§11). 답변 텍스트에 등장한 마커만 `MessageCitation`으로 영속화되는 기존 파이프라인은 변경하지 않는다 — 마커가 하나도 없으면 인용 0건으로 저장된다(abstain은 근거 0건일 때만).

## 수용 기준 (= 동결할 유닛 시나리오, Definition of Done)

1. **openai 스트림 파싱**: SSE 프레임이 청크 경계로 쪼개져(`data: {"choi` + `ces":…}\n\n`) 도착해도 delta가 순서대로 yield되고, `data: [DONE]`에서 정상 종료한다
2. **openai 429**: 상태 429 + `Retry-After: 30` → `LlmProviderError`(`rateLimited=true`, `retryAfterSec=30`). 헤더 없으면 `retryAfterSec` undefined
3. **openai 오류 등급**: 500 → `retryable=true` / 401 → `retryable=false` (둘 다 `LlmProviderError`)
4. **openai abort**: 이미 abort된 signal로 호출 → 토큰 yield 없이 중단되고, 던져진 오류가 `LlmProviderError`가 **아니다**(원 오류 전파)
5. **anthropic 스트림 파싱**: `content_block_delta`(`delta.text_delta`)만 순서대로 yield하고 `message_stop`에서 종료(`message_start`·`ping`·`content_block_start`는 무시). 429·5xx·4xx 매핑은 기준 2·3과 동일
6. **prompt-builder**: 생성된 프롬프트에 각 근거의 마커 `[1]`·`[2]`, 지침 제목, 섹션 경로, 질문이 포함되고 `[n]` 형식 인용 지시 문구가 들어간다
7. **등록 정책**: 키 0개 → `[fake-llm]` / `OPENAI_API_KEY`만 → `[openai]`(fake 미포함) / 둘 다 → `[openai, anthropic]`
8. **모델 기록**: `model`을 가진 프로바이더로 스트림 성공 시 `LlmStreamOutcome.model`이 그 값이고, `model`이 없는 프로바이더면 `undefined`(호출측이 `gateway-routed`로 폴백)

## 테스트 전략 (동결 축소 사유 — implement.md Phase 2)

- 실 어댑터는 **API 키 없이 CI에서 돌아야 하므로 e2e 동결 대상이 아니다.** 위 8개 기준은 `fetch` 목을 쓰는 **유닛(`src/**/*.spec.ts`)으로 동결**한다.
- 게이트웨이 폴백·서킷·rate-limit 차단·SSE 이벤트 계약·인용 영속화는 **기존 06 동결 e2e(기준 4·8·9·11)가 이미 커버**하므로 중복 동결하지 않는다. 이번 변경이 그 계약을 깨지 않는지는 전체 회귀로 확인한다.
- Codex 교차 작성은 **유지**한다(동결할 계약이 존재하므로 심판·선수 분리 원칙이 그대로 성립).

## Out of scope

- **실 임베딩 프로바이더** — 현재 retrieval은 결정적 fake 해시 임베딩이라, 실 LLM을 붙여도 근거 검색 자체는 의미 있는 유사도가 아니다. 실사용 품질을 위해 **바로 다음 스텝(spec 14)으로 이어야 하는 항목**이며, 벡터 차원 1536이 이미 `text-embedding-3-small`과 정합해 마이그레이션은 불필요하다(기존 인제스트 데이터 재적재만 필요)
- response-cache(§11 규칙만 확정), 토큰 사용량 실측(현행 추정치 유지), 프로바이더별 모델 라우팅·비용 정책
- 알림 채널 다중화·운영 배포 인프라(백로그 잔여)
