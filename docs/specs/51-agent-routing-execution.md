# 51. 에이전트 라우팅과 경로 실행 — 질문을 네 갈래로 나누고, 갈래마다 저장까지 흘린다

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> 완료된 spec은 커밋 로그처럼 기록으로 남을 뿐이므로, 이 디렉토리를 읽어 시스템을 이해하려 하지 말 것.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 e2e 테스트로 동결되며, 구현 중 수정할 수 없다.
> 스펙 결함 발견 시: spec을 먼저 고치고 테스트를 재동결한다 (사유를 커밋 메시지에).

## 목표

에이전트가 질문 하나를 **지침·환자·복합·기타** 네 갈래로 나누고, 갈래마다 **답을 단계별로 흘려 끝까지 저장한다**.
끝나면 로그인한 브라우저에서 `POST /api/v1/agent/conversations/{id}/messages/stream`이 네 가지를 흘리고, 결과는 모두 기존
대화·메시지 표에 남는다.
- 지침 질문에는 BE RAG 답변을 흘린다.
- 「CASE-001 알레르기?」에는 그 환자 기록에서 쓴 답을 흘린다.
- 「CASE-001에게 침 치료해도 돼?」에는 기록과 지침 근거를 함께 딛은 답을 흘린다.
- 범위 밖 질문에는 고정 안내를 흘린다.

§49가 이 스텝으로 미룬 「LLM 호출 전 인증 확인」·「실행 도중 access 만료」와, 환자 경로가 들어오며 필요해진 「추적 입출력
숨김·운영 추적 통로」를 함께 닫는다. §49가 깐 경로·자격 전달 위에 얹으며, FE는 아직 이 엔드포인트를 부르지 않는다.

## 실측 조사 (2026-09-13, 3레포 코드 + 운영 DB·nginx + 로컬 LangSmith 캡처 + 분류 모사)

### 운영 질문은 전부 지침형이다 — 「환자」라는 단어는 경로 신호가 아니다 (운영 `messages`, 08-11~09-12)

| 확인 | 실측 |
|---|---|
| 사용자 질문 | 79건(고유 28) — GUIDELINE_QA 42 · PATIENT_GUIDANCE 37 |
| 케이스 라벨로 특정 환자를 지목한 질문 | **0건** |
| 「환자」·`patient`를 환자군 일반명사로 쓴 질문 | **64건(81%)** — 「편두통 환자에서…」 |
| 지침 밖 질문 | 3건 — 인사 2 · 점심 메뉴 1 |
| PATIENT_GUIDANCE 질문에 병명이 있다 | **37/37** — 환자 고정 대화도 질문 자체에 병명을 쓴다(데모 추천 질의문) |
| 케이스 라벨 | 클리닉 5곳 17명, 모두 `CASE-NNN` — 그러나 `caseLabel`은 unique가 아니고(1~50자) 목록 검색은 부분일치 `ILIKE`다(`patient.repository.ts:43`) |

### 분류 모사 — 라벨 차원은 코드에, 의미 차원은 LLM에 (gpt-5.4-mini, 문항당 3회)

분류기가 `{route, patient_labels}`를 내고 코드가 아래 「실행 경로 표」로 실제 경로를 정하는 구성을 합성 경계
44문항(구조 모방 합성 텍스트)과 운영 고유 질문 28건에 돌렸다.

| 구성 | 합성 44 ×3 | 운영 28 ×3 |
|---|---|---|
| 정의만 준 프롬프트(v1) — 분류기 판정 원문 | 125/132 | 84/84 |
| **v1 + 실행 경로 표 — 실행 경로** | **131/132** | **84/84** |
| 라벨 규칙을 프롬프트에 넣음(v2) + 실행 경로 표 | 123/132 | 84/84 |
| 라벨 추출 | 132/132 (소문자 `case-003` 포함) | 84/84 |
| 분류 지연 | p50 0.69초 · p90 0.9초 · 최대 2.6초 | — |

v1의 오답은 한 유형이다. 「알렌드로네이트를 복용 중인 환자에게…」·「고혈압약 먹는 환자한테…」를 3회 모두 **라벨 없는
COMPOSITE**로 봤고, 코드가 지침으로 되돌려 해소된다. v2는 같은 문항을 OTHER로 밀어 표로도 되돌릴 수 없었다. 남은
1건은 지시어 「그 환자에게 침 치료해도 돼?」가 1/3 OTHER로 간 것이다.

### 실행 도중 만료는 드물지만 0이 아니다 (운영 DB, 질문 79건)

| 확인 | 실측 |
|---|---|
| 질문 시점 access 토큰 나이 (`auth_sessions` 회전 시각 기준) | 중앙 95초 · 최대 874초 |
| 남은 수명 30초 · 60초 · 150초 미만에서 보낸 질문 | 1건(1.3%) · 4건(5.1%) · 4건(5.1%) |
| 채팅 턴 소요 (ASSISTANT 수락→종결) | GUIDELINE_QA p50 7.8초·p90 11.7초·최대 17.4초 · PATIENT_GUIDANCE p50 9.3초·최대 14.5초 |
| BE 스트림 LLM 상한 | 120초 (`conversation-stream.service.ts:70`) |
| FE 401 복구 | 상태만 본다(`code` 무관) · 스트림 시작 전 401만(`stream-client.ts:47-57`) |

### BE에 에이전트가 쓸 RAG 도구가 없다

| 확인 | 실측 |
|---|---|
| 검색만 하는 API | **없다** — RAG 진입점은 `POST /conversations/{id}/messages/stream` 하나이고, 부르는 순간 질문·답변 행을 만든다(`conversation-stream.service.ts:166-216`). 복합 경로에 쓰면 곁가지 턴이 남는다 |
| 새 대화 타입을 둘 때 | FE 수기 유니온 `'GUIDELINE_QA' \| 'PATIENT_GUIDANCE'`(`suggested-prompts.ts:94`)에 생성 타입이 그대로 들어가(`chat-panel.tsx:155`) 계약 동기화 PR의 typecheck가 깨진다 |
| 환자 삭제 연쇄 | 환자 삭제는 `conversations.patient_id`로 대화를 파기 예약한다(`patient.repository.ts:115`, §34 기준 9). 파기는 대화 → 환자·스냅샷(`patient_id` 기준) 순이다(`data-purge.repository.ts:223·261`) — **스냅샷을 FK로 가리키는 행이 살아 있는 대화에 남으면 환자 파기가 FK로 실패한다** |
| nginx `auth_request` | 운영 1.31.5에 모듈이 있다(`--with-http_auth_request_module`). 단 하위 요청의 본문을 돌려줄 수 없어 401이 봉투 없는 nginx 응답이 된다 |
| 에이전트용 비밀 | CD 시크릿에 `OPENAI_API_KEY`는 있고 `LANGSMITH_API_KEY`는 없다 |

### LangSmith — 숨김은 클라이언트 경계로만 선다 (langsmith 0.11.0 · langchain-core 1.5.6 · langgraph 1.2.11)

캡처 서버를 엔드포인트로 두고 LangGraph 1회 실행분을 돌렸다(질문 → 분류 → 환자 도구 → 합성 스트림). 그 실행에서
**프로세스를 떠난 바이트**에 표지 문자열이 몇 번 나오는지 셌다.

| 구성 (전부 `configure(enabled=True, client=코드 클라이언트)`) | 질문 | 쿠키 | 환자 기록 | 답변 | 토큰 수 |
|---|---|---|---|---|---|
| 숨김 없음 | 7 | 7 | 5 | 4 | 2 |
| `hide_inputs`·`hide_outputs` = True (`LANGSMITH_HIDE_*=true`도 같다) | 0 | **7** | 0 | 0 | 1 |
| + `hide_metadata` = True | 0 | 0 | 0 | 0 | **0** |
| 쿠키를 `configurable` 대신 LangGraph runtime `context`로 (숨김 없음) | 7 | **0** | 5 | 4 | 2 |
| 도구 예외 메시지에 환자 기록 (`hide_*` 전부 True) | 0 | 0 | **3** | 0 | 0 |
| `hide_inputs/outputs` True + 단일 `anonymizer`(메타데이터 허용목록 · 오류는 예외 클래스만) | 0 | 0 | 0 | 0 | 1 |
| 경로별 클라이언트 — 분류기는 표시, 분기 뒤 `tracing_context(client=숨김)` | 4 | — | 0 | 0 | 2 |
| `LANGSMITH_HIDE_*=false` 환경 + 코드 True | 0 | — | 0 | 0 | — |

함정이 셋이다.
- `configurable` 값은 `hide_inputs`와 무관하게 메타데이터로 샌다.
- `error` 필드는 `hide_*`를 거치지 않고 `anonymizer`만 거친다.
- `anonymizer`를 주면 함수형 `hide_metadata`는 무시된다.

`LANGCHAIN_TRACING_V2=true` 환경에서도 전 요청이 `configure`한 코드 클라이언트 키로 나갔다. SaaS 기본 저장은 미국 GCP
리전, base trace 14일 보존이다.

## 판단 근거 (2026-09-13 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 분류 경계 | **특정 환자는 질문에 적힌 케이스 라벨로만 가리킨다. 라벨 차원은 코드가, 의미 차원은 LLM이 쥔다** — 분류기는 `{route, patient_labels}`만 내고 실행 경로는 아래 표가 정한다. ⑴ 운영 질문의 81%가 「환자」를 환자군으로 쓴다 ⑵ LLM은 조건이 붙은 환자군 질문을 복합으로 기울이는데(3/3), 라벨 유무는 결정론적으로 볼 수 있다 ⑶ 라벨 규칙을 프롬프트로 옮기면 오히려 떨어진다(131 → 123). **이 스텝의 환자 경로는 환자 한 명의 기록만** 다룬다 — 여러 환자의 목록·집계·비교는 기타다(진단명은 암호화 필드라 BE API로 셀 수 없다) |
| 약재 재고 경로 | **분류에서 뺀다 — 원외탕전실을 쓰는 한의원에서는 원내 재고가 무효하다.** 재고·발주 질문은 기타로 떨어진다 |
| 기타 응답 | **LLM 합성 없이 고정 문장의 `ABSTAINED`(`out_of_scope`).** LLM에게 맡기면 범위 밖 질문(「점심 메뉴」)에 실제로 답해 버린다. 흘릴 본문이 없어 분류 직후 종결한다 |
| 저장 계약 | **턴 수락 → 경로 도구 → 완결.** 수락이 질문과 `STREAMING` 답변 행을 LLM보다 먼저 저장한다. 채팅 스트림과 같은 순서라 §8 복구 기준점(`assistantMessageId`)이 그대로 서고, `clientRequestId` 중복이 LLM 비용 전에 막힌다. 저장 주체는 경로별로 갈린다 — 지침은 BE 도구가 수락된 턴에 직접 저장해 생성 이력·인용의 출처가 BE에 남고, 환자·복합·기타는 에이전트가 완결 API로 기록한다. **기각**: 끝에 일괄 기록(실패 시 질문 유실 · 중복 판정이 비용 뒤 · 복구 기준점 없음) · 지침만 기존 채팅 스트림 중계(분류가 저장보다 앞서 인증 선확인 호출이 따로 필요하고, 복합용 도구는 어차피 새로 필요해 저장 경로만 둘로 갈린다) |
| LLM 호출 전 인증 확인 (§49 유보) | **수락 호출이 겸한다.** 첫 BE 호출이 인증·스코프·CSRF·중복을 한 번에 판정하고, 실패하면 SSE도 LLM도 없다. **기각**: nginx `auth_request` — 모듈은 있으나 401이 봉투 없는 nginx 응답이 되고(§10.1), 수락이 어차피 필요해 요청마다 BE 왕복만 하나 늘린다 |
| 기록·도구 API 노출 | **내부 전용 `/api/v1/internal/` — 운영 nginx가 404로 막고 OpenAPI에서 뺀다.** 에이전트가 사용자 쿠키로 부르는 API는 사용자도 부를 수 있다 — 공개면 구성원이 공유 대화(§5.7)에 「AI 답변」과 인용을 지어낼 수 있다. 에이전트는 이미 `http://app:3000`으로 nginx를 거치지 않는다(§49). 인증은 사용자 쿠키 그대로라 스코프·CSRF 판정이 BE에 남는다. **기각**: 서비스 토큰 이중 확인 — 두 번째 인증 축과 시크릿이 늘고, 막으려는 위협(내부망 + 탈취한 사용자 토큰)은 공개 API로 이미 더 많은 것을 할 수 있다 |
| 대화 모델 | **GUIDELINE_QA 대화에 에이전트 턴을 얹는다 — 공개 OpenAPI diff 0.** 경로는 내부 표에만 둔다. 지침 답변은 채팅과 같은 `GUIDELINE_ANSWER`로, 에이전트가 합성한 답변과 기타는 `answerKind` 없이 나간다. 새 기권 사유는 매퍼 문장으로 나간다(`abstainReason`은 문자열이라 enum이 늘지 않는다). **기각**: AGENT 대화 타입 — FE 유니온이 깨져(실측) FE 작업이 딸린다. PATIENT_GUIDANCE 대화는 받지 않는다 — 환자 고정·참고안 검토 흐름은 BE 채팅의 몫이다 |
| 스트리밍 구성 | **브라우저가 보는 스트림은 에이전트 엔드포인트 하나이고, BE 내부 SSE는 둘(지침 답변·근거)이다.** 네 경로 모두 단계별로 흐른다. 환자는 BE 호출이 JSON 한 번(수십 ms)이라 BE 스트림이 필요 없고, 델타는 에이전트 LLM이 낸다. 두 SSE는 채팅 파이프라인을 나눠 쓰되 **종결 의미가 달라**(턴 저장 · 게이트 결과만) 엔드포인트를 나눈다 — 한 도구의 모드로 두면 저장 여부와 종결 이벤트가 모드마다 갈린다 |
| 복합의 지침 근거 | **근거 도구는 게이트 ③에서 멈추고, 생성과 ④ 판정은 에이전트가 원문 근거 + 환자 기록으로 한 번에 한다.** ①~③은 「관련 있나」, ④는 「답할 수 있나」이고 ④는 답을 쓰는 쪽만 판정할 수 있다(§40). BE가 일반론 답까지 쓰면 셋이 망가진다 — ⑴ 생성이 턴당 2회가 되고 첫 델타가 BE 답변(p50 7.8초)만큼 늦다 ⑵ ④가 서로 다른 질문으로 두 번 돌아 엇갈린다 ⑶ 에이전트가 원문이 아니라 요약 위에서 합성한다(조건·금기는 발췌 밖에 있는 경우가 많다 — §33이 원문을 쓴 이유). BE PATIENT_GUIDANCE도 프로필 + 근거로 한 번 생성한다 |
| 복합 판정 방식 | **판정 선행 증분 파싱(§40 이식).** strict JSON의 필드 순서를 `insufficientEvidence` → `answer`로 고정하고, 판정 필드가 닫히기 전에는 델타를 흘리지 않는다. LLM 호출은 1회다. **기각**: 판정 호출 분리(호출 2회 · 첫 델타가 판정만큼 늦고 두 호출이 엇갈릴 수 있다) · 판정 없음(무관 근거를 인용한 산문 거부가 `COMPLETED`로 저장되던 §40 이전으로 돌아간다) |
| 복합 검색 입력 | **BE가 조립한다 — 질문에서 라벨을 지운 문자열을 한국어로 정규화(§42)한 뒤, 그 턴 스냅샷의 진단명을 덧붙인다.** 복합 질문은 자연스럽게 병명을 생략한다(「CASE-001에게 침 치료해도 돼?」). 그대로 검색하면 병명 없는 「침 치료」로 흩어진다 — 환자 고정 대화가 이 문제를 겪지 않은 것은 질문이 병명을 쓰기 때문이다(37/37). 번역 **뒤에** 붙이는 이유: 한글 진단명이 섞이면 §42 언어 판정(한글 비율 0.2)이 짧은 영문 질문을 한국어로 오판한다 |
| 실행 도중 access 만료 (§49 위험 ⑴) | **시작 시 잔여 수명 선검사 + 실행 상한 150초.** 에이전트가 access JWT의 `exp`만 읽어(서명 검증은 BE 몫) 남은 수명이 상한 미만이면 수락 전에 401 `AUTH_TOKEN_EXPIRED`를 낸다 → FE가 refresh 후 1회 재시도한다. 상한을 코드가 강제하므로 도중 만료가 「드물다」가 아니라 「없다」가 된다. 대가는 운영 분포로 요청 약 5%의 refresh 1회다. 상한 150초는 BE 스트림 LLM 상한 120초에 분류·도구 여유를 더한 값이다. **토큰 전체 수명(`exp − iat`)이 상한 이하이면 선검사하지 않는다** — 새 토큰으로도 못 넘으면 FE가 두 번째 401에서 강제 로그아웃한다. 조작된 `exp`는 수락에서 BE가 거부하므로 에이전트가 읽는 값은 판정이 아니라 힌트다. **기각**: 완결 전용 턴 토큰(중간 도구 호출은 여전히 쿠키가 필요하고 BE에 새 자격이 생긴다) · 감수(LLM 비용 뒤 답을 버리고 턴이 `STREAMING`으로 남는다) |
| 환자 삭제 연쇄 | **§34 연쇄를 에이전트 턴까지 넓힌다 — 그 환자의 스냅샷을 쓴 턴이 있는 대화도 같은 트랜잭션에서 파기 예약한다.** PATIENT_GUIDANCE 대화가 가는 길과 같다. 에이전트 턴은 `patient_id` 없는 대화에 얹혀 오늘의 연쇄를 타지 못한다. 스냅샷 FK를 걸고 대화를 남기면 환자 파기가 FK로 실패한다 — §34가 연쇄를 택한 이유(`clinical_guidances.patient_snapshot_id`)와 같다. 대가는 같은 대화의 다른 턴도 함께 지워지는 것이다. **기각**: 연쇄 없음(환자를 지워도 그 기록을 옮긴 답변이 남는다) · 턴 단위 삭제(메시지 소프트 삭제가 모든 메시지 조회로 번진다) |
| 추적 숨김 범위 | **경로가 환자·복합으로 정해진 뒤의 실행은 전부 숨김 클라이언트로 돈다 — 분류기와 지침 경로는 보인다.** 숨길 실행을 목록으로 고르면 빠진다: 환자 도구 출력만 숨기면 같은 기록이 합성 프롬프트로 다시 실린다. 숨김 클라이언트는 입출력을 비우고, 메타데이터는 허용목록(토큰 수·모델·노드·traceId)만, 오류는 예외 클래스만 남긴다 — 실측의 세 함정을 한 anonymizer로 닫는다. **access 토큰은 경로와 무관하게 runtime context로만 넘긴다**(`configurable`은 메타데이터로 샌다). 분류기 입력(질문 원문)이 남는 것은 **§14 「프롬프트 원문 로그 금지」의 명시적 예외**다 — 경로가 정해지기 전이라 숨길 기준이 없고, 오분류를 트레이스에서 바로 본다. **기각**: 전부 숨김(오분류 디버깅이 DB 대조로만 가능) · 전부 보이기(암호화해 둔 필드가 미국 리전에 평문으로 남는다 — §4.5·§14 개정) |
| 운영 추적 통로 | **compose가 `AGENT_TRACING_ENABLED`·`LANGSMITH_API_KEY`를 통과시키고, CD는 전자를 저장소 변수·후자를 시크릿으로 넘긴다 — 기본 꺼짐.** 켜려면 시크릿을 등록하고 변수 한 줄을 넣은 뒤 재배포한다. 킬스위치를 vars에 둔 선례(§33·§40·§45)와 같이 GitHub에서 끄고 켠다. SDK 스위치(`LANGSMITH_TRACING`·`LANGCHAIN_TRACING_V2`)는 여전히 싣지 않는다(§49) |
| 에이전트 LLM | **BE와 같은 `OPENAI_API_KEY` 시크릿, 같은 기본 모델 `gpt-5.4-mini`**(TTFT 중앙 0.8초 — `llm.config.ts`). 합성 호출은 generation run, 분류는 턴의 분류기 버전으로 DB에 남는다. 키를 나누면 로테이션 지점만 둘이 된다 |

**실행 경로 표** (분류기 출력 → 코드. 라벨은 대소문자를 무시하고 서로 다른 것만 센다)

| 분류기 `route` | 라벨 | 실행 경로 | 결말 |
|---|---|---|---|
| GUIDELINE | 0 | 지침 | BE 지침 도구 |
| GUIDELINE | 1 | 복합 | — |
| PATIENT | 1 | 환자 | 환자 도구가 `NOT_FOUND`·`AMBIGUOUS`면 `ABSTAINED` `patient_unresolved` |
| PATIENT | 0 | 환자 | 도구 없이 `ABSTAINED` `patient_unresolved` |
| COMPOSITE | 1 | 복합 | 환자 해석 실패는 위와 같다 |
| COMPOSITE | 0 | 지침 | — |
| 무엇이든 | 2 이상 | 기타 | `ABSTAINED` `out_of_scope` |
| OTHER | — | 기타 | `ABSTAINED` `out_of_scope` |

**위험.**
- ⑴ **분류는 확률적이다.** 131/132는 합성 경계 문항 기준이고, 운영 분포에는 특정 환자 질문이 아직 0건이다. 코드는 라벨 차원만 결정론적으로 보증한다.
- ⑵ **선제 401은 FE refresh를 부른다.** 여러 탭이 동시에 refresh하면 재사용 감지로 family가 폐기될 수 있고(§39 운영 감지 2건), 이 경합 기회가 요청의 약 5%만큼 늘 수 있다.
- ⑶ **대화 단위 연쇄는 같은 대화의 지침 턴까지 지운다.**
- ⑷ **내부 경로 차단은 운영 nginx 한 곳의 보증이다.** nginx 없는 로컬 개발에서는 사용자가 내부 API를 부를 수 있다(§49 위험 ⑷와 같은 구조).
- ⑸ **질문 원문이 LangSmith에 남는다.** 추적이 켜진 동안 분류기 입력이 미국 리전에 14일간 남고, 질문에 적은 환자 상태도 함께 남는다.
- ⑹ **턴이 `STREAMING`으로 남을 수 있다.** 에이전트가 죽거나 BE가 완결 호출에 응답하지 않은 경우다 — §8 복구가 재시도 UI를 띄우지만 정리 크론은 없다.
- ⑺ **임상 메모가 합성 프롬프트에 들어간다.** 자유 텍스트 4,000자라 프롬프트 주입이 가능하지만, 도구가 모두 읽기 전용이고 스코프 판정이 BE에 있어 피해는 그 답변에 그친다.
- ⑻ **상한이 지침 도구를 끊으면 두 상태가 어긋난다.** BE는 클라이언트 끊김으로 보고 `CANCELLED`로 정리하고, 화면은 `LLM_TIMEOUT`을 본다 — 둘 다 §8 재시도 대상이다.

## 범위 (엔드포인트)

**공개 BE 엔드포인트 신규·변경 없음 — OpenAPI diff 0.** 새 BE API는 전부 내부 전용이다(`/api/v1/internal/`, nginx 404 ·
OpenAPI 제외). 에이전트 엔드포인트는 BE `openapi/`에 들어가지 않는다(FE 계약은 Out of scope).

| API (AGENT) | Request | Response data | 참조 |
|---|---|---|---|
| `POST /api/v1/agent/conversations/{conversationId}/messages/stream` | `{ content, clientRequestId, responseLang? }` + `Cookie`·`X-CSRF-Protection` | 시작 전 실패는 봉투(본문 검증 422 · 선제 401 · 수락의 4xx 그대로 · 502) · 이후 SSE(아래 흐름) | §8 · §10.1 |

| API (BE 내부 — 에이전트만 부른다) | Request | Response |
|---|---|---|
| `POST /api/v1/internal/agent/conversations/{conversationId}/turns` | `{ content, clientRequestId, responseLang? }` | 201 `{ userMessageId, assistantMessageId }` — GUIDELINE_QA 대화만 |
| `POST /api/v1/internal/agent/turns/{assistantMessageId}/guideline-answer` | `{ classifierVersion }` | SSE — 채팅 스트림에서 `message.accepted`를 뺀 §8 이벤트. 결과·실패·끊김을 채팅과 같은 규칙으로 그 턴에 저장(`GUIDELINE_ANSWER` · 자동 제목 포함) |
| `POST /api/v1/internal/agent/turns/{assistantMessageId}/patient` | `{ caseLabel }` | 200 `{ outcome: 'RESOLVED', patient }` · `{ outcome: 'NOT_FOUND' }` · `{ outcome: 'AMBIGUOUS' }` — RESOLVED면 스냅샷을 고정하고 `patient`는 그 읽기의 PatientDetail |
| `POST /api/v1/internal/agent/turns/{assistantMessageId}/guideline-evidence` | `{ query }` | SSE — `retrieval.started` → `retrieval.progress`* → `evidence.gated` → `retrieval.evidence`×N → `retrieval.completed`. 저장 없음 |
| `POST /api/v1/internal/agent/turns/{assistantMessageId}/finish` | `{ status, route?, classifierVersion?, content?, abstainReason?, citations?, generation? }` | 200 `MessageResponseDto` |

- 내부 도구·완결은 **수락이 만든 턴만** 다룬다 — 그 밖의 메시지는 404, `STREAMING`이 아닌 턴은 409 `AGENT_TURN_CLOSED`다.
- **턴을 닫는 주체는 경로마다 하나다** — 지침은 지침 도구가, 나머지는 에이전트의 완결이 닫는다. 그래서 근거 도구는 실패하거나 끊겨도 턴을 바꾸지 않고 `error` 이벤트로만 알린다(채팅 파이프라인의 실패 정리를 타지 않는다).
- `evidence.gated`는 `{ abstainReason, evidenceCount, retrievalPolicyVersion, searchQuestion }`이다.
- `finish.citations`는 `[{ marker, evidenceId }]`이고 quote는 BE가 채팅과 같은 규칙으로 만든다.
- `finish.generation`은 `{ provider, model, promptVersion, latencyMs, inputTokens, outputTokens, retrievalPolicyVersion?, searchQuestion? }`이다.

**이벤트 흐름 (에이전트 → 브라우저).** `agent.progress`는 새 이벤트 타입이며 §46 규약(모르는 `stage`는 무시 · 필드는 그
stage에만)을 따른다. 하트비트는 §8과 같은 15초 `: ping`이다.

```
공통  message.accepted → agent.progress{stage:routed, route}
지침  ◀ guideline-answer 그대로: retrieval.started → retrieval.progress* → answer.started → retrieval.evidence×N
      → retrieval.completed → answer.delta* → answer.completed | answer.abstained | error
환자  patient → agent.progress{stage:patient_loaded} → answer.delta*(에이전트 LLM) → [finish] → answer.completed
복합  patient → agent.progress{stage:patient_loaded} → ◀ guideline-evidence: retrieval.started → retrieval.progress*
      → (evidence.gated 통과 → answer.started{evidenceCount}) → retrieval.evidence×N → retrieval.completed
      → answer.delta*(판정 뒤, 에이전트 LLM) → [finish] → answer.completed | answer.abstained
기타  [finish] → answer.abstained                          (환자·복합의 라벨 해석 실패도 같다)
실패  error{code, retryable, traceId} — 환자·복합·기타는 [finish FAILED]
끊김  환자·복합·기타는 [finish CANCELLED] · 지침은 지침 도구가 CANCELLED로 정리(§8-4)
```

| 진입점 (AGENT — medical-agentic-rag) | 변경 |
|---|---|
| `app/service/routes.py` | 스트림 엔드포인트 — 선검사 → 수락 → SSE(하트비트) → 분류 → 경로 실행 → 종결. 실행 상한 150초 |
| 분류기 (신규) | strict 구조화 출력 `{route, patient_labels}` · 버전 `gpt-5.4-mini/agent-route-v1` · 실행 경로 표는 순수 함수 |
| 경로 실행 (신규) | 환자 합성(텍스트 스트림) · 복합 합성(판정 선행 증분 파서 `insufficientEvidence` → `answer`) · 마커 → 인용 · generation 정보 |
| `app/service/backend.py` | 내부 API 클라이언트(JSON·SSE) — Cookie는 그대로, CSRF는 받았을 때만(§49) |
| `app/service/tracing.py` | 분기 뒤 숨김 클라이언트(입출력 비움 + anonymizer: 메타데이터 허용목록·오류는 예외 클래스) · 자격은 runtime context로만 · 프로젝트명 고정 |
| `app/service/config.py` · `envelope.py` | `OPENAI_API_KEY` · 미러링 코드 `AUTH_TOKEN_EXPIRED`·`LLM_UNAVAILABLE`·`LLM_TIMEOUT`·`VALIDATION_FAILED` |
| `docs/architecture.md` | 서비스 구조와 경계 원칙(분류·경로·추적 숨김) |

| 진입점 (BE) | 변경 |
|---|---|
| `conversation-stream.service.ts` | 수락(메시지 생성)과 파이프라인(검색·게이트·생성·저장)을 나눈다 — 채팅 스트림·지침 도구·근거 도구(③까지)가 같은 파이프라인을 쓴다 |
| `src/domain/agent-turn/` (신규) | 내부 컨트롤러(`@ApiExcludeController`) · `agent_turns` 스키마·레포지토리 · 라벨 해석(대소문자 무시 정확 일치 · 클리닉 스코프 · 삭제 제외) · 완결 검증 |
| `patient.service.ts` · 레포지토리 | 환자 삭제가 에이전트 턴 스냅샷을 따라 대화도 같은 tx에서 예약 |
| `data-purge.repository.ts` | `agent_turns`를 메시지보다 먼저 삭제 |
| `conversation.mapper.ts` | 기권 문장 `out_of_scope`·`patient_unresolved` (ko·en) |
| `error-code.registry.ts` | `AGENT_TURN_CLOSED` |
| `nginx/conf.d/api.conf` | `location ^~ /api/v1/internal/ { return 404; }` |
| `docker/gcp/compose.yml` | `agent` 환경에 `OPENAI_API_KEY`·`AGENT_TRACING_ENABLED`·`LANGSMITH_API_KEY` 통과, 머리 주석 갱신 |
| `.github/workflows/cd-gcp.yml` | `AGENT_TRACING_ENABLED`(vars)·`LANGSMITH_API_KEY`(secrets) — env와 envs 목록 |
| `docs/architecture.md` | §0 에이전트 행 · §5.7 에이전트 턴과 삭제 연쇄 · §8 에이전트 스트림 · §9 AgentTurnEntity · §14 추적 숨김과 §14 예외 |

**배포 순서는 무관하다** — 에이전트 엔드포인트의 소비자가 아직 없다. BE가 먼저면 내부 API가 기다리고, AGENT가 먼저면
수락이 404로 막힐 뿐이다.

**배포 후 확인 (동결 밖)**
- ① `https://api.cure.demo01.xyz/api/v1/internal/agent/turns/x/finish`가 404다.
- ② 로그인한 탭에서 네 경로의 대표 질문을 보내 이벤트 흐름과 `agent_turns.route`를 확인한다.
- ③ `cure-agent` 환경에 `OPENAI_API_KEY`가 있다(값은 보지 않는다).
- ④ 추적을 켠 뒤 복합 질문 1건의 트레이스에서 분기 뒤 실행 입출력이 비어 있고 분류기 입력은 보인다.
- ⑤ 시험 환자를 지우면 그 환자를 쓴 에이전트 대화에 `deleted_at`이 찍힌다.

## Entity / 마이그레이션 변경분

- **`agent_turns` 신설.** 수락이 만든 턴의 경로·분류기 버전·환자 스냅샷을 담는다.
  - `message_id` — PK, ASSISTANT 메시지를 가리킨다.
  - `user_message_id` — USER 메시지를 가리킨다.
  - `route` — `agent_route`(GUIDELINE·PATIENT·COMPOSITE·OTHER). 경로가 정해지기 전에는 NULL이다.
  - `classifier_version` — NULL 허용.
  - `patient_snapshot_id` — `patient_profile_snapshots`를 가리키며 NULL 허용. 삭제 연쇄 조회용 인덱스를 둔다.
  - base columns.
- `abstain_reason` enum에 `out_of_scope`·`patient_unresolved`를 추가한다.
- `generation_runs.retrieval_policy_version`의 NOT NULL을 해제한다. NULL은 「검색하지 않은 생성」(환자 경로)이라는 뜻이다.
- 파괴적 변경은 없다.

## 추가 에러코드

- `AGENT_TURN_CLOSED` (409) — 내부 도구·완결이 이미 `STREAMING`이 아닌 턴에 도착했다. 에이전트만 받는 코드다.
  - `DUPLICATE_CLIENT_REQUEST`는 수락 시점의 요청 중복이라 쓸 수 없다.
  - 404로 뭉개면 「수락하지 않은 메시지」와 구분되지 않아 에이전트가 원인을 가를 수 없다.
- 에이전트는 기존 코드의 미러링만 늘린다(§10.2): `AUTH_TOKEN_EXPIRED` · `LLM_UNAVAILABLE` · `LLM_TIMEOUT` · `VALIDATION_FAILED`.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

**에이전트 — 수락 전에 거른다**

1. access 토큰의 `exp`까지 150초 미만이면 401 `AUTH_TOKEN_EXPIRED` 봉투다 (AGENT 유닛)
2. 그때 BE를 부르지 않는다 (AGENT 유닛)
3. 토큰 전체 수명(`exp − iat`)이 150초 이하이면 남은 수명과 무관하게 수락을 부른다 (AGENT 유닛 — 새 토큰으로도 못 넘으면 FE가 두 번째 401에서 강제 로그아웃한다)
4. access 쿠키가 없으면 수락이 돌려준 401의 상태·봉투가 그대로 나간다 (AGENT 유닛 — 인증 판정은 BE의 몫)

**수락이 LLM보다 먼저다**

5. 수락 호출에 받은 `Cookie`를 바꾸지 않고 싣는다 (AGENT 유닛)
6. 요청에 `X-CSRF-Protection`이 없으면 수락 호출에도 없다 (AGENT 유닛 — §49 기준 6과 같은 이유)
7. 수락이 4xx면 응답이 그 상태·봉투 그대로다 — 401·403·404·409 각각 (AGENT 유닛 — 스트림 시작 전이라 FE의 refresh 복구가 걸린다)
8. 수락이 4xx면 LLM을 부르지 않는다 (AGENT 유닛 — 비로그인 요청이 분류 비용을 태우지 못한다)
9. 수락에 응답이 없으면 502 `AGENT_BACKEND_UNAVAILABLE`이다 (AGENT 유닛)

**스트림 공통**

10. 첫 이벤트가 `message.accepted`이고 수락이 준 두 id와 요청의 `clientRequestId`(`requestId`)를 싣는다 (AGENT 유닛 — §8 복구 기준점)
11. 두 번째 이벤트가 `agent.progress`(`stage=routed`)이고 `route`가 실행 경로다 (AGENT 유닛)
12. 하트비트 주기 동안 보낼 이벤트가 없으면 `: ping` 주석을 보낸다 (AGENT 유닛 — 주기는 주입한다)
13. 종결 이벤트의 `message`가 완결 응답의 메시지다 — `answer.completed`·`answer.abstained` 각각 (AGENT 유닛)

**실행 경로는 표가 정한다** (분류기는 `{route, patient_labels}`를 돌려주는 가짜다)

14. 판정과 라벨이 맞물린 세 경우는 판정대로 도구를 부른다 — GUIDELINE·0개는 지침 도구만, PATIENT·1개는 환자 도구만, COMPOSITE·1개는 환자 도구와 근거 도구, 각각 (AGENT 유닛)
15. GUIDELINE·라벨 1개는 복합으로 실행한다 (AGENT 유닛 — 라벨이 있으면 특정 환자다)
16. COMPOSITE·라벨 0개는 지침으로 실행한다 (AGENT 유닛 — 조건이 붙은 환자군 질문이 3/3 이렇게 왔다, 실측)
17. PATIENT·라벨 0개면 어떤 도구도 부르지 않는다 (AGENT 유닛)
18. 그때 `ABSTAINED`·`patient_unresolved`로 완결한다 (AGENT 유닛)
19. 서로 다른 라벨이 2개 이상이면 판정과 무관하게 어떤 도구도 부르지 않는다 (AGENT 유닛)
20. 그때 `ABSTAINED`·`out_of_scope`로 완결한다 (AGENT 유닛)
21. 대소문자만 다른 라벨은 1개로 센다 (AGENT 유닛)
22. OTHER면 분류 뒤로 LLM을 더 부르지 않는다 (AGENT 유닛 — 범위 밖 질문에 답하지 않는다)
23. 그때 `ABSTAINED`·`out_of_scope`로 완결한다 (AGENT 유닛)
24. 지침 도구 요청과 완결 요청에 분류기 버전을 싣는다 — 각각 (AGENT 유닛 — 「왜 이 경로였나」의 재현성, §5.7)

**지침 — BE 파이프라인을 그대로 흘린다**

25. 지침 도구가 보낸 이벤트를 순서와 내용 그대로 흘린다 (AGENT 유닛)
26. 지침 경로는 완결 API를 부르지 않는다 (AGENT 유닛 — 저장은 BE 도구가 한다)

**환자**

27. 환자 도구가 `RESOLVED`면 `agent.progress`(`stage=patient_loaded`)를 보낸다 (AGENT 유닛)
28. 합성 LLM 입력에 환자 도구가 돌려준 기록 필드 값이 실린다 (AGENT 유닛)
29. 합성 스트림 조각이 `answer.delta`로 나간다 (AGENT 유닛)
30. `answer.delta`의 `seq`가 0부터 연속이다 (AGENT 유닛 — §8 순서·중복 감지)
31. 완결 요청이 `route=PATIENT`·`status=COMPLETED`다 (AGENT 유닛)
32. 완결 `content`가 델타를 이은 전체 텍스트다 (AGENT 유닛)
33. 완결 `generation`에 model·promptVersion·토큰 수가 있다 (AGENT 유닛)
34. 그 `generation`에 `retrievalPolicyVersion`이 없다 (AGENT 유닛 — 검색하지 않은 생성)
35. 환자 도구가 `NOT_FOUND`·`AMBIGUOUS`면 합성 LLM을 부르지 않는다 — 각각 (AGENT 유닛)
36. 그때 `ABSTAINED`·`patient_unresolved`로 완결한다 — 각각 (AGENT 유닛)

**복합**

37. 환자 도구가 근거 도구보다 먼저 불린다 (AGENT 유닛 — BE가 그 턴 스냅샷의 진단명을 검색 입력에 붙인다)
38. 근거 도구의 `query`는 질문에서 라벨을 지운 문자열이다 (AGENT 유닛)
39. `evidence.gated`가 통과면 `answer.started`(`evidenceCount`)를 첫 `retrieval.evidence`보다 앞에 보낸다 (AGENT 유닛 — §47 순서)
40. `evidence.gated`는 브라우저로 흘리지 않는다 (AGENT 유닛)
41. `evidence.gated`가 기권이면 합성 LLM을 부르지 않는다 (AGENT 유닛)
42. 그때 그 사유로 `ABSTAINED` 완결한다 (AGENT 유닛)
43. 합성 LLM 입력에 근거 원문(`excerpt`)과 환자 기록 필드 값이 실린다 — 각각 (AGENT 유닛)
44. 판정 필드가 닫히기 전에는 `answer.delta`가 없다 (AGENT 유닛 — 가짜 스트림을 판정 앞에서 멈춰 둔 채 단언한다)
45. `insufficientEvidence=true`면 `answer.delta`가 하나도 없다 (AGENT 유닛)
46. 그때 `ABSTAINED`·`insufficient_evidence`로 완결한다 (AGENT 유닛)
47. 그 완결에도 `generation`을 싣는다 (AGENT 유닛 — 「ABSTAINED + run = 생성 게이트」 불변식, §8)
48. 답변에 등장하지 않은 마커는 `citations`에 없다 (AGENT 유닛)
49. 근거 수를 넘는 마커는 답변에 등장해도 `citations`에 없다 (AGENT 유닛)
50. 마커 n의 `evidenceId`는 n번째 `retrieval.evidence` 프레임의 근거 id다 (AGENT 유닛)
51. 완결 `generation`의 `retrievalPolicyVersion`·`searchQuestion`은 `evidence.gated`가 준 값이다 (AGENT 유닛)

**실패는 턴을 닫는다**

52. 분류 LLM이 실패하면 `error`(`LLM_UNAVAILABLE`, `retryable=true`)를 보낸다 (AGENT 유닛)
53. 그때 `FAILED`로 완결한다 (AGENT 유닛)
54. 실행 상한을 넘으면 `error`(`LLM_TIMEOUT`)를 보낸다 (AGENT 유닛 — 상한은 주입한다)
55. 환자·복합·기타 경로에서 상한을 넘으면 `FAILED`로 완결한다 (AGENT 유닛)
56. 클라이언트가 끊으면 `CANCELLED`로 완결한다 (AGENT 유닛)
57. 스트림 도중 BE 도구에 응답이 없으면 `error`(`AGENT_BACKEND_UNAVAILABLE`, `retryable=true`)를 보낸다 (AGENT 유닛)
58. 근거 도구가 `error`를 보내면 그 이벤트를 흘린다 (AGENT 유닛)
59. 그때 `FAILED`로 완결한다 (AGENT 유닛 — 근거 도구는 턴을 닫지 않는다)

**추적 — 환자·복합 분기 뒤는 숨긴다** (`AGENT_TRACING_ENABLED=true`, 요청 본문을 기록하는 가짜 엔드포인트)

60. 네 경로 어느 요청에서도 추적 페이로드에 access 토큰 값이 없다 — 각각 (AGENT 유닛 — `configurable`은 숨김과 무관하게 샌다, 실측)
61. 분류기 실행의 입력에 질문 원문이 있다 (AGENT 유닛 — 보이기로 한 쪽이 실제로 보인다)
62. 환자·복합 경로 요청의 페이로드에 환자 도구가 돌려준 기록 필드 값이 없다 — 각각 (AGENT 유닛)
63. 환자·복합 경로 요청의 페이로드에 합성 답변 텍스트가 없다 — 각각 (AGENT 유닛)
64. 분기 뒤에서 기록 값을 담은 예외가 나도 페이로드에 그 값이 없다 (AGENT 유닛 — `error` 필드는 `hide_*`를 거치지 않는다, 실측)
65. 분기 뒤 합성 LLM 실행이 페이로드에 있다 (AGENT 유닛 — 끄는 것이 아니라 숨긴다)
66. 분기 뒤 LLM 실행의 입력 토큰 수가 페이로드에 남는다 (AGENT 유닛)
67. `LANGSMITH_HIDE_INPUTS=false`·`LANGSMITH_HIDE_OUTPUTS=false` 환경에서도 기준 62가 성립한다 (AGENT 유닛 — 환경변수가 코드의 숨김을 풀지 못한다)

**BE — 수락**

68. 201로 돌려준 두 id가 새로 생긴 USER·ASSISTANT 메시지다 (BE e2e)
69. USER 메시지는 요청 `content`에 `COMPLETED`다 (BE e2e)
70. ASSISTANT 메시지는 빈 content에 `STREAMING`이다 (BE e2e)
71. ASSISTANT 메시지에 `answerKind`가 없다 (BE e2e — 경로가 정해지기 전이다)
72. 두 메시지의 `responseLang`이 요청 값이다 — `en` 명시·미지정(`ko`) 각각 (BE e2e)
73. ASSISTANT 메시지의 `agent_turns` 행이 `route` 없이 생긴다 (BE e2e)
74. 같은 `clientRequestId`를 다시 보내면 409 `DUPLICATE_CLIENT_REQUEST`다 (BE e2e)
75. 타 클리닉 대화는 404다 (BE e2e — §4.4)
76. PATIENT_GUIDANCE 대화는 400 `BAD_REQUEST`다 (BE e2e)
77. 수락은 대화 제목을 바꾸지 않는다 (BE e2e — 경로가 정해지기 전이라 질문에 환자 기록이 섞였는지 모른다)

**BE — 지침 도구**

78. 스트림에 `message.accepted`가 없다 (BE e2e — 수락이 이미 보냈다)
79. 완료하면 수락된 ASSISTANT 메시지가 `COMPLETED`와 답변 content를 갖는다 (BE e2e)
80. 그 메시지의 `answerKind`가 `GUIDELINE_ANSWER`다 (BE e2e — 채팅의 지침 답변과 같은 모양)
81. 대화의 메시지 수가 수락 직후 그대로다 (BE e2e — 새 턴을 만들지 않는다)
82. 인용과 generation run이 수락된 메시지에 저장된다 — 각각 (BE e2e)
83. `agent_turns.route`가 GUIDELINE이다 (BE e2e)
84. `agent_turns.classifier_version`이 요청 값이다 (BE e2e)
85. 제목이 기본값인 대화에는 그 질문으로 자동 제목이 붙는다 (BE e2e — GUIDELINE_QA 채팅과 같은 규칙)
86. 에이전트가 수락하지 않은 메시지에 부르면 404다 (BE e2e — 채팅이 만든 ASSISTANT 메시지로 단언)
87. `STREAMING`이 아닌 턴에 부르면 409 `AGENT_TURN_CLOSED`다 (BE e2e)

**BE — 환자 도구**

88. 대소문자를 무시하고 라벨이 정확히 일치하는 환자가 1명이면 `outcome`이 `RESOLVED`다 (BE e2e)
89. 그때 `patient`에 복호화된 기록 필드가 실린다 (BE e2e)
90. 그때 `agent_turns.patient_snapshot_id`가 새 스냅샷을 가리킨다 (BE e2e)
91. 부분 일치만 있으면 `NOT_FOUND`다 (BE e2e — `CASE-00`은 `CASE-001`이 아니다)
92. 타 클리닉 환자의 같은 라벨은 `NOT_FOUND`다 (BE e2e — §4.4)
93. 같은 라벨의 환자가 2명이면 `AMBIGUOUS`다 (BE e2e — `caseLabel`은 unique가 아니다)
94. `AMBIGUOUS`면 스냅샷을 만들지 않는다 (BE e2e)
95. 같은 턴에 다시 부르면 스냅샷이 늘지 않는다 (BE e2e — 재시도 멱등)

**BE — 근거 도구**

96. 게이트를 통과하면 이벤트가 `retrieval.started` → `retrieval.progress` → `evidence.gated` → `retrieval.evidence`×N → `retrieval.completed` 순이다 (BE e2e)
97. LLM 생성을 부르지 않는다 (BE e2e — fake LLM 호출 0)
98. 턴 메시지가 빈 content에 `STREAMING` 그대로다 (BE e2e)
99. 인용과 generation run을 만들지 않는다 — 각각 (BE e2e)
100. 검색 게이트 기권이면 `evidence.gated.abstainReason`이 그 사유다 (BE e2e)
101. 그때 `retrieval.evidence` 프레임이 없다 (BE e2e)
102. 근거 도구가 실패하면 `error` 이벤트를 보낸다 (BE e2e — fake 임베딩 실패로 단언)
103. 근거 도구가 실패하거나 연결이 끊겨도 턴은 `STREAMING` 그대로다 — 각각 (BE e2e — 턴을 닫는 것은 에이전트의 완결이다)
104. 턴에 스냅샷이 있으면 `searchQuestion`이 그 스냅샷의 진단명으로 끝난다 (BE e2e)
105. 영문 `query`면 번역기 입력에 진단명이 없다 (BE e2e — 번역한 뒤에 붙인다)

**BE — 완결**

106. `PATIENT`·`COMPLETED`면 content와 상태가 저장된다 (BE e2e)
107. 그때 `agent_turns.route`가 PATIENT다 (BE e2e)
108. 그때 generation run이 `retrieval_policy_version` NULL로 저장된다 (BE e2e)
109. 완결에 실린 `classifierVersion`이 `agent_turns.classifier_version`에 저장된다 (BE e2e)
110. `COMPOSITE`·`COMPLETED`의 `citations`가 메시지 목록의 인용(marker·근거 id)으로 나온다 (BE e2e)
111. 존재하지 않는 근거 id를 인용하면 422 `VALIDATION_FAILED`다 (BE e2e)
112. `ABSTAINED`의 사유가 메시지 목록 `abstainReason`에 그 사유의 문장으로 나온다 — `out_of_scope`·`patient_unresolved` 각각 (BE e2e)
113. `COMPOSITE`·`insufficient_evidence` 완결에 실린 `generation`이 run으로 남는다 (BE e2e — §8 불변식)
114. `STREAMING`이 아닌 턴의 완결은 409 `AGENT_TURN_CLOSED`다 (BE e2e)
115. 그때 기존 상태와 content가 그대로다 (BE e2e)
116. 완결 응답 메시지에 `answerKind`가 없다 (BE e2e — 공개 enum에 새 값을 만들지 않는다)

**BE — 공개 계약은 그대로다**

117. 커밋된 OpenAPI에 `/api/v1/internal/` 경로가 없다 (BE contract)

**BE — 환자 삭제가 에이전트 대화에도 번진다**

118. 환자 삭제가 그 환자의 스냅샷을 쓴 에이전트 턴이 있는 대화에 `deleted_at`을 찍는다 (BE e2e)
119. 그 환자를 쓰지 않은 대화의 `deleted_at`은 그대로다 (BE e2e)
120. 유예가 지나면 파기가 그 대화와 환자를 오류 없이 지운다 (BE e2e — `agent_turns` → 메시지 → 스냅샷 순)

**nginx가 내부 경로를 막는다** (§49의 nginx 하네스)

121. `/api/v1/internal/` 아래 요청은 404다 (BE e2e)
122. 그 요청은 app에 닿지 않는다 (BE e2e)

**운영 구성이 추적·LLM 통로를 연다** (compose 파싱)

123. `agent` 환경에 `AGENT_TRACING_ENABLED` 키가 있다 (BE e2e — §49 기준 37을 대체한다)
124. `agent` 환경에 `LANGSMITH_API_KEY` 키가 있다 (BE e2e)
125. `agent` 환경에 `OPENAI_API_KEY` 키가 있다 (BE e2e)
126. `agent` 환경에 `LANGSMITH_TRACING`·`LANGCHAIN_TRACING_V2` 키가 없다 (BE e2e — 켜는 수단은 앱 스위치 하나다, §49)

fixture 규약:
- **AGENT 유닛은 실제 BE·LLM·LangSmith를 부르지 않는다.**
  - BE: 요청을 기록하는 fake 전송(§49)이 내부 API의 JSON·SSE 응답을 합성한다.
  - LLM: 분류기·합성 LLM은 스트림 조각과 usage를 싣는 LangChain 가짜 채팅 모델이다.
  - 추적: 요청 본문을 기록하는 가짜 엔드포인트로 치환하고, 프로세스를 떠난 바이트에서 표지 문자열을 센다(실측 조사와 같은 방법).
  - access 토큰: `exp`·`iat`만 다르게 만든 서명 없는 합성 JWT다.
- **환자 기록·질문·근거는 구조를 모방한 합성 텍스트다** — 데모 환자 원문을 쓰지 않는다.
- **BE e2e는 §13대로 Testcontainers에 fake LLM·임베딩·리랭커·번역기를 쓴다.** 내부 API는 사용자 쿠키로 app을 직접 부르고, nginx 차단은 기준 121·122가 따로 본다. 기존 채팅 스트림 스위트(§27~§48)가 파이프라인 분리의 회귀 가드다.
- **이 문서의 수치는 단언 대상이 아니다** — 분류 정확도(131/132)·토큰 나이 분포·턴 소요는 환경의 성질이다. 동결하는 것은 실행 경로 표·저장 계약·게이트 순서·숨김 경계·삭제 연쇄·구성 불변식이다.

## Out of scope

- **FE 계약·화면** — 에이전트 엔드포인트의 OpenAPI 병합·codegen과 `agent.progress` 렌더는 FE가 에이전트를 처음 소비하는 스텝에서 한다(§49 유보 그대로).
- **다중 턴 문맥** — 「그 환자」 같은 지시어 해석. 이번 스텝은 턴마다 독립으로 분류한다(BE 채팅도 단일 턴이다).
- **여러 환자의 목록·집계·비교, 진단명 검색** — 암호화 필드라 BE에 새 조회 설계가 필요하다.
- **환자 기록 쓰기** — 에이전트는 등록·수정·삭제를 하지 않는다. 그런 요청은 기타다.
- **약재 재고 경로** — 원외탕전실을 쓰는 한의원에서는 무효라 분류에서 뺐다.
- **PATIENT_GUIDANCE 대화의 에이전트화와 복합 답변의 참고안 구조화·의료인 검토(§33)** — 환자 고정 흐름은 BE 채팅의 몫이다.
- **에이전트 HTTP·도메인 메트릭** — 소비자가 없어 분모가 여전히 자기 헬스체크다(§50 유보 그대로).
- **`STREAMING` 턴 정리 크론**(위험 ⑹) · **턴 단위 삭제**.
- **서비스 간 인증(서비스 토큰)·API 게이트웨이** — §49의 재검토 조건이 아직 오지 않았다.
- **에이전트↔BE traceId 연결** — BE는 수신 헤더를 읽지 않는다(§49).
- **LangSmith 셀프호스팅·EU 리전** — 셀프호스팅은 Enterprise 전용이다.
- **분류 정확도 평가 하네스** — 운영에 특정 환자 질문 표본이 쌓인 뒤에 만든다.
