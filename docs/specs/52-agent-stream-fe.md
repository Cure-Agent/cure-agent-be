# 52. 에이전트 스트림 FE 계약·화면 — 지침 질의가 에이전트를 부르고, 기다림이 경로를 말한다

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> 완료된 spec은 커밋 로그처럼 기록으로 남을 뿐이므로, 이 디렉토리를 읽어 시스템을 이해하려 하지 말 것.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 e2e 테스트로 동결되며, 구현 중 수정할 수 없다.
> 스펙 결함 발견 시: spec을 먼저 고치고 테스트를 재동결한다 (사유를 커밋 메시지에).

## 목표

브라우저의 **일반 대화(GUIDELINE_QA)가 에이전트 엔드포인트를 부른다.** 끝나면 `/assistant`에서 「CASE-001 알레르기?」를 치면
환자 기록으로 쓴 답이 흐르고, 「CASE-001에게 침 치료해도 돼?」는 기록과 근거를 함께 딛은 답이 흐르며, 범위 밖 질문에는
고정 안내가 뜬다. 기다리는 동안 화면은 **경로가 정해졌다는 사실과 환자 기록을 읽었다는 사실**을 문구로 말한다.

§51이 「FE 계약·화면」으로 미룬 것 — 에이전트 엔드포인트의 OpenAPI 표현·codegen과 `agent.progress` 렌더 — 을 닫는다.
에이전트는 §51로 운영 배포가 끝났고 소비자만 없다(§8 「계약 원본은 에이전트 레포이며 FE 소비·OpenAPI 병합은 아직 없다」).

## 실측 조사 (2026-09-14, FE·AGENT·BE 코드 + 운영 DB)

### FE는 전송 경로가 하나이고, 에이전트 이벤트를 모른다

| 확인 | 실측 |
|---|---|
| 전송 진입점 | `send-message.ts` 하나 — `POST /conversations/{id}/messages/stream`. `ChatPanel`이 대화 타입(`conversation.data.type`)을 이미 안다(`chat-panel.tsx:155`) |
| `filters` | `send-message.ts`가 인자로 받지만 **`chat-panel.tsx`는 넘기지 않는다**(사용처 0). 에이전트 요청 모델(`StreamMessageRequest`)은 `content`·`clientRequestId`·`responseLang` 셋뿐이고 모르는 필드는 조용히 버린다 |
| reducer | `agent.progress`는 `default`로 무시된다. 환자 경로는 `retrieval.started`가 없어 **첫 델타까지 「질문을 분석하는 중…」이 그대로**다. 첫 `answer.delta`는 `accepted`에서 곧장 `streaming`으로 올린다(정상) |
| 기권 렌더 | `AbstainedNotice`가 `message.abstainReason`을 그대로 그린다. 새 사유 `out_of_scope`·`patient_unresolved`는 문장이 BE 매퍼에 ko·en으로 있어 화면 변경 없이 흐른다 |
| 401 복구 | `stream-client.ts`는 스트림 전 401 → `ensureRefreshed()` → 1회 재시도 → 재401이면 `notifyUnauthorized()`. 에이전트 선검사 401 `AUTH_TOKEN_EXPIRED`(§51 기준 1)와 그대로 맞물린다 |
| 스트림 전 5xx | `postStream`이 봉투를 읽어 `ApiError`로 던지고 `ChatPanel`이 `streamFailed`(retryable)로 받는다 — 502 `AGENT_BACKEND_UNAVAILABLE`도 오늘 코드로 「재시도」가 뜬다 |
| 로컬 개발 | `next.config.ts` rewrites가 `/api/v1/:path*` 전부를 `BE_ORIGIN`(3000)으로 보낸다. `/api/v1/agent/*` 규칙이 없어 로컬에서는 에이전트에 닿지 않는다. 운영은 nginx가 `/api/v1/agent/`를 `agent:8000`으로 보낸다(§49) |
| FE e2e | `guideline-qa.spec.ts`가 BE 채팅 경로를 스텁하고 **그 경로를 단언한다**(`:75`). `mockApi()`는 `/api/v1/**`를 전부 가로채므로 에이전트 경로도 같은 스텁 규약 안이다 |

### 에이전트 엔드포인트는 어느 OpenAPI에도 없다

| 확인 | 실측 |
|---|---|
| BE `openapi/cure-agent.v1.json` | `/api/v1/agent/` 경로 0. 문서 생성은 `openapi-document.factory.ts` 한 곳이고 contract 테스트(§51 기준 117)가 `/api/v1/internal/` 부재만 본다 |
| 에이전트 | FastAPI 문서 경로(`/docs`·`/openapi.json`)를 닫아 두었다(`main.py:89`). 요청 모델은 BE `AcceptAgentTurnRequestDto`와 같다고 **주석으로** 적혀 있다 |
| FE 계약 원칙 | §1 「FE에 수동 DTO를 만들지 않는다」 · CI가 `api:generate` 재생성 diff=0을 검사한다 |

### 운영 에이전트 턴 — 네 경로가 한 번씩 돌았다 (운영 `agent_turns`, 09-14 09:51 KST)

| route | 결과 | content | 인용 | 비고 |
|---|---|---|---|---|
| GUIDELINE | COMPLETED · `GUIDELINE_ANSWER` | 226자 | 4 | 채팅과 같은 모양 |
| PATIENT | COMPLETED · `answerKind` 없음 | 33자 | 0 | 환자 기록만으로 쓴 답 |
| COMPOSITE | ABSTAINED · `insufficient_evidence` | 0 | 0 | 생성 게이트 ④ 기권 |
| OTHER | ABSTAINED · `out_of_scope` | 0 | 0 | LLM 합성 없음 |

환자 라벨은 5클리닉 17명이고 `CASE-001`~`CASE-003`이 클리닉마다 있다. 분류 지연은 p50 0.69초(§51 실측)라 「질문을 분석하는
중…」이 실제로 보이는 구간이 있고, 그 뒤에야 경로 문구로 바뀐다.

## 판단 근거 (2026-09-14 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 전환 방식 | **무조건 전환 — GUIDELINE_QA면 항상 에이전트를 부른다. 되돌림은 FE 재배포다.** BE 채팅 경로는 PATIENT_GUIDANCE가 계속 쓰므로 코드에 남고, 롤백은 전송 경로 한 줄이다. **기각**: 빌드 플래그(두 환경의 플래그 상태·테스트 매트릭스 2배) · 런타임 폴백(에이전트 5xx면 BE 채팅으로 — 전송 경로 둘이 영구 공존하고, 수락 뒤 끊김에서 같은 질문이 두 번 저장된다) |
| 계약 원천 | **BE OpenAPI에 문서 전용 경로를 싣는다** — `/api/v1/agent/conversations/{conversationId}/messages/stream`을 BE가 서빙하지 않지만 문서에는 둔다. 요청 스키마는 기존 `AcceptAgentTurnRequestDto`(같은 모양, §51)이고 contract-sync가 FE 타입을 자동 생성한다. §1 「OpenAPI가 두 레포 사이의 공식 계약」이 지켜지고 FE는 수기 DTO 없이 `paths[...]` 타입으로 본문을 조립한다. **의도적 예외**: BE 문서가 BE 밖 서비스의 경로를 말한다 — nginx가 같은 오리진에서 그 경로를 에이전트로 보내므로 FE에게는 한 API다. 기계가 못 잡는 것은 **에이전트 pydantic 모델과 BE DTO의 어긋남**이며 오늘도 주석에 의존한다(Out of scope). **기각**: FE 수기 타입(§1 예외가 FE에 생긴다) · 에이전트 OpenAPI 병합(codegen·sync 파이프라인이 둘) |
| 경로 표시 | **대기 문구만 바꾼다.** 답변 말풍선은 일반 답변과 같고, 경로는 `agent_turns`에만 산다(§51 「경로는 내부 표에만 둔다」). 다시 열면 그 답이 환자 기록을 썼는지 화면이 말하지 않는다 — 감수한다. **기각**: `MessageResponseDto`에 경로 필드를 더해 배지(BE 계약·매퍼·e2e가 이 스텝에 들어온다) |
| 예시 질문 | **넣지 않는다.** 케이스 라벨 예시는 그 클리닉의 실제 라벨(환자 목록 조회)이 필요하다 — Out of scope |
| 문구의 축 | **§46과 같다 — 단계는 `stage` 필드로 쪼개고 모르는 stage·모르는 `route`는 무시한다.** `agent.progress`는 상태를 만들지 않으므로 §8 복구 기준점(`assistantMessageId`)이 그대로다. 문구 우선순위는 오늘의 `waitingLabel`을 넓힌다: `generating` > 검색 단계 > **환자 단계** > 폴백. 복합은 환자 기록을 읽은 뒤 검색 단계가 오므로 검색 단계 문구가 환자 문구를 덮고, `answer.started`에서 「환자 기록과 지침 근거 N건을 바탕으로」로 합쳐 말한다 |
| `filters` | **에이전트 경로에는 싣지 않는다** — 오늘 FE도 넘기지 않고(사용처 0) 에이전트는 받지 않는다. `send-message.ts`의 `filters` 인자는 PATIENT_GUIDANCE 경로에 남긴다 |
| 로컬 개발 | **rewrites에 `/api/v1/agent/:path*` → `AGENT_ORIGIN`(기본 `http://localhost:8000`)을 일반 규칙보다 앞에 둔다.** 운영 nginx의 `location ^~ /api/v1/agent/`와 같은 분기다. Playwright `webServer.env`는 `BE_ORIGIN`처럼 `AGENT_ORIGIN`도 거부 주소로 고정한다(스텁이 빠져도 새지 않는다, e2e README) |

## 범위 (엔드포인트)

**신규·삭제 없음 — BE OpenAPI에 문서 전용 경로 하나가 더해진다.** 응답 형태는 §8 「에이전트 스트림」이다.

| API (문서 전용 — 서빙은 에이전트, nginx가 `agent:8000`으로 보낸다) | Request | Response | 참조 |
|---|---|---|---|
| `POST /api/v1/agent/conversations/{conversationId}/messages/stream` | `AcceptAgentTurnRequestDto` (`content`·`clientRequestId`·`responseLang?`) | SSE(§8 에이전트 스트림). 스트림 전 실패는 봉투 — 401 `AUTH_TOKEN_EXPIRED`(선검사)·404·409 `DUPLICATE_CLIENT_REQUEST`·422 `VALIDATION_FAILED`·502 `AGENT_BACKEND_UNAVAILABLE` | §8 · §10.1 · §51 |

| 진입점 (BE) | 변경 |
|---|---|
| `src/global/openapi/openapi-document.factory.ts` | 문서 전용 경로 추가 — `extraModels`로 `AcceptAgentTurnRequestDto`를 components에 올리고, 채팅 스트림 경로와 같은 문체로 이벤트 흐름(`agent.progress` stage `routed`·`patient_loaded`, 네 경로)과 스트림 전 실패 코드를 description·responses에 적는다. 태그 `Agent` |
| `openapi/cure-agent.v1.json` | `pnpm openapi:export` 재생성 |
| `test/contract/openapi-sync.e2e-spec.ts` | 에이전트 경로 존재·요청 스키마 참조 단언 추가 |
| `docs/architecture.md` | §1 문서 전용 경로 예외 · §5.3 표에 「질문 및 스트리밍(일반 대화)」 행 · §8 「FE 소비·OpenAPI 병합은 아직 없다」 문장 갱신 |

| 진입점 (FE — cure-agent-fe) | 변경 |
|---|---|
| `src/shared/api/generated/` | `pnpm api:sync` — 에이전트 경로 타입이 생성된다 |
| `src/features/ask-guideline/api/send-message.ts` | 대화 타입을 받아 GUIDELINE_QA면 에이전트 경로·`filters` 없는 본문, PATIENT_GUIDANCE면 오늘 경로. 본문 타입은 생성 스키마 |
| `src/features/ask-guideline/model/stream-state.model.ts` | `agent.progress` 배선 — `agentRoute`(닫힌 4값 또는 null)·`patientLoaded`. phase는 건드리지 않는다 |
| `src/features/ask-guideline/ui/chat-panel.tsx` | `send`가 대화 타입을 넘긴다. `waitingLabel`에 환자 단계·복합 생성 문구 |
| `src/shared/i18n/messages.ts` | `agentReadingPatient`·`agentDraftingFromPatient`·`agentDraftingComposite` ko/en |
| `next.config.ts` · `playwright.config.ts` | `AGENT_ORIGIN` rewrite(일반 규칙보다 앞) · e2e `webServer.env`에 거부 주소 |
| `e2e/guideline-qa.spec.ts` | 스텁·단언 경로를 에이전트 경로로 |

**배포 순서는 BE가 먼저다** — BE 문서 경로가 main에 실려야 contract-sync PR이 FE 타입을 만든다. FE는 그 타입 위에서
구현한다(FE CI의 재생성 diff=0 검사가 수기 타입을 막는다). BE 변경은 문서와 테스트뿐이라 운영 동작이 바뀌지 않는다.

**배포 후 확인 (동결 밖)**
- ① 운영 `/assistant`에서 일반 대화에 네 경로의 대표 질문을 보내 문구 전환과 답변·기권을 본다(`agent_turns`가 4건 늘어난다).
- ② 환자 고정 대화가 오늘 경로(`/conversations/{id}/messages/stream`)로 가는 것을 네트워크 탭으로 본다.
- ③ 로컬에서 `uvicorn` 에이전트 + BE + FE로 같은 흐름이 돈다(rewrite 확인).

## Entity / 마이그레이션 변경분

- 없음 — 문서와 화면만 바뀐다.

## 추가 에러코드

- 없음 — 에이전트가 이미 내는 코드(§49·§51)를 FE가 오늘의 규칙으로 받는다.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

**BE — 공개 계약이 에이전트 경로를 말한다**

1. 커밋된 OpenAPI에 `POST /api/v1/agent/conversations/{conversationId}/messages/stream`이 있다 (BE contract)
2. 그 요청 스키마가 `AcceptAgentTurnRequestDto`를 참조한다 (BE contract — 에이전트 요청 모델과 같은 모양, §51)
3. 그 응답 정의에 401·409·422·502가 있다 (BE contract — 스트림 전 실패는 봉투다)
4. 커밋된 OpenAPI에 `/api/v1/internal/` 경로가 여전히 없다 (BE contract — §51 기준 117 회귀)
5. BE 앱에 그 경로를 요청하면 404다 (BE e2e — 문서 전용이다, 서빙은 에이전트)

**FE — 전송 경로가 대화 타입으로 갈린다**

6. GUIDELINE_QA 대화의 전송이 `/api/v1/agent/conversations/{id}/messages/stream`으로 간다 (FE 유닛)
7. PATIENT_GUIDANCE 대화의 전송은 `/api/v1/conversations/{id}/messages/stream` 그대로다 (FE 유닛)
8. 에이전트 경로의 본문에 `content`·`clientRequestId`가 있고 `filters` 키가 없다 (FE 유닛)
9. 유도된 `responseLang`이 에이전트 경로 본문에 실린다 — `en` 유도·`ko` 미기재 각각 (FE 유닛 — §44 규칙 그대로)
10. 에이전트 경로 요청에 `X-CSRF-Protection`과 `credentials: include`가 있다 (FE 유닛 — 수락이 CSRF·쿠키를 판정한다, §51)
11. 재시도가 새 `clientRequestId`로 에이전트 경로에 간다 (FE 유닛 — §8 회귀)
12. 스트림 전 401이면 refresh 뒤 재시도가 **에이전트 경로**로 간다 (FE 유닛 — 선검사 401 `AUTH_TOKEN_EXPIRED` 복구)
13. 스트림 전 502 봉투(`AGENT_BACKEND_UNAVAILABLE`)면 봉투 `message`가 오류 상자에 뜨고 재시도 버튼이 있다 (FE 유닛)

**FE — 기다림이 경로를 말한다** (`agent.progress`는 §46 stage 규약)

14. `stage=routed`·`route=PATIENT`를 받으면 대기 문구가 「환자 기록을 읽는 중…」이다 (FE 유닛)
15. `route=COMPOSITE`도 같다 (FE 유닛)
16. `route=GUIDELINE`·`route=OTHER`는 대기 문구를 바꾸지 않는다 (FE 유닛 — 지침은 곧 `retrieval.*`가, 기타는 곧 기권이 온다)
17. `agent.progress`는 `phase`를 바꾸지 않는다 (FE 유닛 — 진행 이벤트는 상태를 만들지 않는다, §46)
18. PATIENT 경로에서 `stage=patient_loaded` 뒤 문구가 「환자 기록을 바탕으로 답변을 작성하는 중…」이다 (FE 유닛)
19. PATIENT 경로는 `retrieval.*` 없이 첫 `answer.delta`에서 `streaming`으로 올라가 본문을 그린다 (FE 유닛)
20. COMPOSITE 경로에서 `patient_loaded` 뒤 `retrieval.progress`가 오면 그 단계 문구가 환자 문구를 덮는다 (FE 유닛 — 검색 단계가 더 최근 사실이다)
21. COMPOSITE 경로의 `answer.started`에서 문구가 「환자 기록과 지침 근거 N건을 바탕으로 답변을 작성하는 중…」이고 N은 `evidenceCount`다 (FE 유닛 — §47)
22. GUIDELINE 경로의 `answer.started` 문구는 오늘 그대로다 (FE 유닛 — 회귀)
23. 모르는 `stage`·모르는 `route`를 받아도 상태가 바뀌지 않는다 (FE 유닛 — 에이전트가 경로·단계를 늘려도 화면이 없는 진행을 지어내지 않는다)
24. 새 문구 3종이 ko·en 양쪽에 있다 (FE 유닛 — §42·§44와 같은 이유)
25. 경과 시간 표시가 환자 단계 문구에서도 이어진다 (FE 유닛 — 회귀)

**FE — 기권과 근거는 오늘의 규칙이다**

26. `answer.abstained`의 `message.abstainReason`이 그대로 보인다 — `out_of_scope`·`patient_unresolved` 문장 각각 (FE 유닛 — 화면이 문장을 바꾸지 않는다, §43)
27. 대화를 다시 열어도 그 기권 문장이 같다 (FE 유닛 — 재조회 경로 회귀)
28. COMPOSITE 경로의 `retrieval.evidence` 프레임이 근거 카드로 누적된다 (FE 유닛 — §47 회귀, 경로가 달라도 프레임은 같다)
29. 완료 메시지의 인용 마커가 근거 패널을 연다 (FE 유닛 — 회귀)

**FE — 로컬·e2e 경로**

30. `next.config.ts`의 rewrites에서 `/api/v1/agent/:path*` 규칙이 일반 규칙보다 앞에 있고 `AGENT_ORIGIN`으로 간다 (FE 유닛 — `rewrites()` 반환값 단언)
31. e2e 「대화 생성 → 질문 → 스트리밍 → 인용」이 에이전트 경로 스텁으로 끝까지 돌고 BE 채팅 경로로 새는 요청이 없다 (FE e2e — `api.unhandled`가 빈 배열)

fixture 규약:
- **FE 유닛의 경로·본문·헤더 단언(6~13)은 `fetch`를 가짜로 두고 `postStream`까지 실제 코드를 돌린다** — 오늘의 `sendMessageStream` vi.mock은 경로를 볼 수 없다. 스트림 본문은 `ReadableStream`으로 SSE 프레임을 합성한다.
- **문구·단계 단언(14~29)은 오늘의 방식(`sendMessageStream` mock + `onEvent`로 이벤트 주입)** 을 쓴다. 이벤트 순서는 §8 「에이전트 스트림」 흐름을 따른다.
- **질문·답변·환자 기록·근거는 구조를 모방한 합성 텍스트다** — 데모 환자 원문과 운영 질문을 쓰지 않는다. 케이스 라벨은 `CASE-901`처럼 운영에 없는 값이다.
- **BE contract는 커밋된 JSON을 읽는다**(§51 기준 117과 같은 방식). 기준 5는 부팅한 앱에 요청한다.
- **이 문서의 수치는 단언 대상이 아니다** — 운영 턴 4건·분류 지연은 환경의 성질이다. 동결하는 것은 경로 분기·본문 모양·문구 우선순위·전방 호환·복구 경로다.

## Out of scope

- **에이전트 요청 모델과 BE DTO의 기계적 동기화** — 오늘도 주석에 의존한다. 어긋나면 에이전트가 422를 내고 FE 오류 상자에 드러난다.
- **답변 배지·경로 필드** — 재조회에서 「환자 기록 기반」을 보이려면 공개 계약이 늘어난다. 운영에 특정 환자 질문이 쌓인 뒤 판단한다.
- **환자·복합·기타 턴의 자동 제목** — 완결은 제목을 붙이지 않는다(§51 기준 77의 연장). 첫 질문이 환자 질문이면 대화가 기본 제목으로 남는다.
- **예시 질문에 케이스 라벨** — 클리닉의 실제 라벨 조회가 필요하다.
- **런타임 폴백·빌드 플래그** — 되돌림은 FE 재배포다.
- **온보딩 투어의 에이전트 안내** · **PATIENT_GUIDANCE 대화의 에이전트화**(§51).
- **에이전트 HTTP·도메인 메트릭** — 소비자가 생기므로 §50 유보의 재검토 조건이 이 스텝 뒤에 온다. 여기서는 하지 않는다.
