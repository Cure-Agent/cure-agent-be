# 55. 에이전트 완결의 자동 제목 — 경로가 정해진 완결이 첫 질문으로 대화 제목을 붙이고, 남은 기본 제목을 백필한다

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> 완료된 spec은 커밋 로그처럼 기록으로 남을 뿐이므로, 이 디렉토리를 읽어 시스템을 이해하려 하지 말 것.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 e2e 테스트로 동결되며, 구현 중 수정할 수 없다.
> 스펙 결함 발견 시: spec을 먼저 고치고 테스트를 재동결한다 (사유를 커밋 메시지에).

## 목표

일반 대화(GUIDELINE_QA)를 **어느 경로의 질문으로 시작해도** 대화 목록에 첫 질문이 제목으로 선다. 오늘은 지침 경로만 붙이고
환자·복합·기타 경로의 완결은 제목을 두지 않아(§51 기준 77의 연장, §52 Out of scope), 「CASE-001에게 침 치료해도 돼?」로
시작한 대화가 답변 뒤에도 '새 대화'로 남는다. 끝나면 **경로가 정해진 완결이 종결과 같은 tx에서** 채팅과 같은 규칙
(`deriveConversationTitle` — 공백 접기 + 40 코드포인트 + …)으로 제목을 붙이고, 이미 남은 기본 제목 대화는 마이그레이션이 채운다.

공개 계약·FE·에이전트는 바뀌지 않는다 — FE는 종결 뒤 목록을 재조회하므로(cure-agent-fe#117) 완결 tx 안에서 붙이면 그대로 보인다.

## 실측 조사 (2026-09-27, 운영 DB + BE 코드)

### 기본 제목으로 남은 대화는 전부 에이전트 대화다 (운영, 07-28~09-27)

| 확인 | 실측 |
|---|---|
| GUIDELINE_QA 제목 출처 | `DEFAULT` 16 · `AUTO` 31 · `USER` 3 (PATIENT_GUIDANCE 40은 전부 `USER` — BE는 생성 시 제목을 강제하지 않지만 FE가 늘 준다) |
| `DEFAULT` 16건의 구성 | **에이전트 턴이 있는 대화 9건**(첫 턴 경로 COMPOSITE 6 · PATIENT 3) + 메시지 0건 대화 7건(그중 5건 삭제 예약). 채팅으로 시작해 기본 제목으로 남은 대화는 **0건** — 채팅은 수락 시점에 붙이므로 |
| 에이전트 턴 22건 | `route` NULL 0 · `STREAMING` 잔존 0. 경로 × 제목 출처: PATIENT 7(DEFAULT 5) · COMPOSITE 10(DEFAULT 8) · GUIDELINE 3 · OTHER 2(DEFAULT 0) |
| 제목이 첫 질문이 아닌 대화 | 1건 — 환자 → 복합 → **지침**(3번째 턴)에서야 `AUTO`가 붙어 제목이 3번째 질문이다. 오늘 규칙이 만드는 모양이다 |
| 첫 질문의 내용 | 9건 모두 라벨 + 시술명·「진단명과 알레르기를 알려줘」 같은 **항목명**이다. 진단명·투약 **값**이 질문에 쓰인 예는 0건 — 위험은 관측되지 않았을 뿐 성립한다(아래 판단 근거) |
| `AUTO` 제목 길이 | 31건 중 28건이 41자(40 + …) — 지침 질문은 대개 40자를 넘는다. 백필 규칙의 자르기가 곧 표시 규칙이다 |
| 백필 모사 | 아래 마이그레이션의 SELECT를 운영에서 읽기 전용으로 돌렸다 — **정확히 9행**, 첫 질문 8~30자로 잘리는 건 없다. 메시지 0건 대화 7건은 걸리지 않는다 |

### 붙일 자리는 이미 있다 (BE 코드)

| 확인 | 실측 |
|---|---|
| 규칙 | `deriveConversationTitle`(`conversation-title.util.ts`) 한 곳. `applyAutoTitle`은 GUIDELINE_QA 한정 + **`title_source='DEFAULT'`일 때만 서는 조건부 UPDATE**라 매 턴 불려도 첫 한 번만 성립한다(`conversation.repository.ts:174-178`) |
| 오늘의 호출처 | 채팅 수락(`conversation-stream.service.ts:330`, `autoTitle`) · 지침 도구의 경로 기록 tx(`agent-turn.service.ts:116`). 에이전트 수락은 `autoTitle: false`(`:87`), 완결(`finish`, `:219`)에는 제목 처리가 없다 |
| 제외의 근거 | `conversation-stream.service.ts:315-328` 주석 — 환자 맞춤 질문의 첫 문장에 §4.5 암호화 항목(진단명·투약·알레르기)이 섞이는데 `title`은 평문 text이자 `ILIKE` 검색 대상(`conversation.repository.ts:141`)이라 암호화 경계를 우회한다는 것. 에이전트 수락은 「경로가 정해지기 전이라 모른다」로 같은 이유를 잇는다(§51 기준 77) |
| 완결이 가진 것 | `route`(선택 — 분류 전 실패는 없이 온다) · `status` · `loaded.user.content`(첫 질문 그대로 — run의 `originalQuestion`에 이미 쓴다) · `loaded.conversation`. **에이전트 변경 없이 BE만으로 판정 가능** |
| 백필 전례 | `0015`가 같은 규칙을 SQL로 구현했다(`DISTINCT ON (conversation_id) … ORDER BY id`, `left(cleaned, 40) \|\| '…'`). 유틸 주석이 「규칙을 단순하게 두는 이유는 SQL 구현이 하나 더 있기 때문」이라고 못 박는다 |
| 동결된 이웃 기준 | §51 기준 77(수락은 제목을 바꾸지 않는다)·85(지침 도구는 붙인다)는 그대로 참이다 — 이 스텝은 **완결**에 붙인다. 기준 106~116(완결)은 제목을 단언하지 않는다 |
| 공개 계약 | `ConversationSummaryResponseDto.title`·`ConversationDetailResponseDto.title`은 string이고 `titleSource`는 노출되지 않는다 — OpenAPI diff 0 |

## 판단 근거 (2026-09-27 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 제목의 원천 | **질문 원문 그대로 — 채팅과 같은 `deriveConversationTitle`.** 라벨을 지우거나 LLM 요약을 하지 않는다. **§4.5 경계를 감수하는 것이 사용자의 명시적 선택이다**: 환자 맞춤 질문의 진단명·투약 값이 평문 `title`(ILIKE 검색 대상)에 실릴 수 있다. 근거 — ⑴ 환자 이름·차트번호는 애초에 저장하지 않고 식별자는 비식별 `caseLabel`뿐이다, ⑵ 운영 9건의 첫 질문은 전부 항목명이었다(값은 라벨 뒤의 기록에서 나오므로 질문에 쓸 이유가 적다), ⑶ 같은 값이 이미 `generation_runs.search_question`(복합 검색 입력, §8)과 `messages.content`(질문 원문)에 평문으로 있어 **`title`이 새 노출 축이 아니다** — 대화 파기가 환자 삭제 연쇄에 묶이는 것도 같다(§5.7). 기각: 라벨 제거·제목 미부여(사용자가 보고한 결함이 그대로다) |
| 범위 | **경로가 정해진 완결 전부 — PATIENT·COMPOSITE·OTHER, 상태 무관(`COMPLETED`·`ABSTAINED`·`FAILED`·`CANCELLED`).** 채팅은 수락 시점에 붙여 실패·기권 대화도 제목을 가진다 — 「대화한 사실」이 목록에 남아야 한다는 같은 이유다. 환자만 물은 대화(운영 3건)도 같은 종류의 위험이라 수용 범위가 늘지 않는다. **`route` 없는 완결(분류 전 실패)은 제외** — 이 스텝의 규칙은 「경로가 정해진 완결」이고, 그 대화는 오늘처럼 기본 제목으로 남는다. 기각: COMPOSITE만(환자 질문 대화는 같은 보고가 다시 온다) · 수락 시점(§51 기준 77을 뒤집어 재동결하고, 얻는 것은 분류 전 실패 턴의 제목뿐이다) |
| 어디서 | **완결의 종결 tx 안 — `closeStreamingMessage`가 선 뒤, `recordRoute`와 함께.** 종결이 조건부 UPDATE로 지면(닫힌 턴, 409) 제목도 서지 않는다 — 답변 없이 제목만 남는 상태를 막는 채팅 수락의 방식 그대로다. FE 재조회(#117)가 종결 뒤이므로 **같은 tx여야** 추가 이벤트 없이 보인다 |
| 첫 질문의 정의 | **그 턴의 USER 메시지(`loaded.user.content`)다.** 조건부 UPDATE가 「기본 제목인 대화」에만 서므로 두 번째 턴의 질문은 붙지 않는다 — 다만 앞 턴이 `route` 없이 실패했으면 그 다음 턴의 질문이 제목이 된다(채팅은 첫 수락이 결말과 무관하게 붙이므로 이 경우만 다르다. 운영 0건이라 감수한다) |
| 백필 | **한다 — `0029` 마이그레이션.** 대상은 `title_source='DEFAULT'`·GUIDELINE_QA·**`route`가 있는 에이전트 턴이 하나 이상인** 대화, 제목은 첫 USER 메시지(`id` 오름차순)를 `0015`와 같은 SQL 규칙으로 자른 것. 메시지 0건 대화 7건은 첫 메시지가 없어 대상이 아니고, 채팅 대화는 오늘 대상이 없다(실측 0건). 기대 갱신은 **9행**이다. `0015` 규칙과 어긋나면 런타임과 백필이 다른 제목을 만들므로 SQL을 그대로 잇는다. 첫 턴이 `route` 없이 끝난 대화만 런타임(다음 턴의 질문)과 백필(첫 질문)이 갈리는데, 운영에 `route` NULL 턴이 0건이라 감수한다 |
| §51 기준 77·§52 Out of scope | **원문은 고치지 않는다** — 스펙은 기록이다. 기준 77의 단언(수락은 제목을 바꾸지 않는다)은 그대로 참이고 **근거 문장만 바뀐다**: 「질문에 환자 기록이 섞였는지 모른다」가 아니라 「제목은 경로가 정해진 완결의 몫이다」. 그 개정은 `conversation-stream.service.ts:315` 주석·`agent-turn.service.ts:86` 주석·architecture.md §5.7에 쓴다 |
| 공개 계약·FE·AGENT | **diff 0.** FE 표시 해석(`conversation-title.ts`)은 원문 제목을 그대로 그린다. 에이전트는 완결에 이미 `route`를 싣는다 |

**위험.**
- ⑴ **§4.5 값이 평문 `title`에 실릴 수 있다**(수용). 질문에 진단명·투약을 쓴 사용자의 대화는 목록·검색에서 그 값이 보인다 — 구성원 누구나 보는 클리닉 공유 자산이다(§5.7). 같은 값은 이미 `messages.content`에 있다.
- ⑵ **완결 tx가 UPDATE 하나 늘어난다** — 조건부라 첫 턴 뒤로는 0행 갱신이다.
- ⑶ **백필은 되돌리지 않는다** — 9건의 제목을 사용자가 바꾸면 `USER`가 되어 이후 자동 규칙과 무관해진다(오늘과 같다).

## 범위 (엔드포인트)

**공개 BE 엔드포인트 신규·변경 없음 — OpenAPI diff 0.** 내부 완결의 요청·응답 모양도 그대로다.

| 진입점 | 변경 |
|---|---|
| `src/domain/agent-turn/service/agent-turn.service.ts` | 완결 — `dto.route`가 있으면 종결·경로 기록과 **같은 tx에서** `applyAutoTitle(loaded.conversation, loaded.user.content)`. 수락의 `autoTitle: false` 주석을 「완결의 몫」으로 개정 |
| `src/domain/conversation/service/conversation-stream.service.ts` | `applyAutoTitle` 주석의 에이전트 수락 제외 근거를 개정 — 에이전트는 완결이 붙인다. PATIENT_GUIDANCE 제외와 그 §4.5 근거는 그대로 두고, GUIDELINE_QA의 에이전트 완결은 그 경계를 **알고 수용한다**(이 스펙)고 적는다 |
| `drizzle/migrations/0029_agent_turn_title_backfill.sql` (신규) | 아래 마이그레이션 |
| `docs/architecture.md` | §5.7 에이전트 턴 문단의 「지침은 … 자동 제목까지 채팅과 같다」를 「제목은 경로가 정해진 완결이 붙인다」로 · §4.5 아래에 `title` 평문 수용의 한 줄 |

**배포 후 확인 (동결 밖)**
- ① `route` 있는 에이전트 턴을 가진 GUIDELINE_QA 대화 중 `title_source='DEFAULT'`가 0건이다 (작성 시점 기준 9건이 갱신 대상이다. 배포 전까지 대화가 늘 수 있어 건수가 아니라 불변식으로 본다).
- ② 운영 일반 대화에 복합 질문 1건 · 환자 질문 1건 — 답변 뒤 목록에 그 질문이 제목으로 보인다. ③ 새로고침해도 같다.

## Entity / 마이그레이션 변경분

- 컬럼·인덱스 없음. `0029` — 데이터 백필 UPDATE 1문: `0015`의 `DISTINCT ON (conversation_id) … ORDER BY id` 첫 USER 메시지 + `btrim(regexp_replace(content, '\s+', ' ', 'g'))` + `char_length > 40 → left(…, 40) || '…'`, 조건은 `title_source='DEFAULT' AND type='GUIDELINE_QA' AND cleaned <> ''` **AND `EXISTS (agent_turns JOIN messages … WHERE route IS NOT NULL)`**. `title_source`는 `AUTO`.

## 추가 에러코드

- 없음 — 공통 코드로 충분.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

**완결이 첫 질문으로 제목을 붙인다** (수락 → 완결. 지침 도구·근거 도구는 부르지 않는다)

1. 기본 제목 대화의 `COMPOSITE`·`COMPLETED` 완결 뒤 `GET /conversations/{id}`의 `title`이 그 턴의 질문이다 (BE e2e — 40 코드포인트 이하 질문)
2. 그때 `conversations.title_source`가 `AUTO`다 (BE e2e)
3. 41 코드포인트 이상의 질문이면 `title`이 앞 40 코드포인트 + `…`다 (BE e2e — 채팅과 같은 규칙. BMP 밖 문자를 포함해 단언한다)
4. `PATIENT`·`COMPLETED` 완결도 제목을 붙인다 (BE e2e)
5. `OTHER`·`ABSTAINED` 완결도 제목을 붙인다 (BE e2e — 기권 대화도 목록에서 알아볼 수 있어야 한다)
6. `COMPOSITE`·`FAILED` 완결도 제목을 붙인다 (BE e2e — 채팅은 실패로 끝난 대화에도 제목이 있다)
7. `GET /conversations` 목록의 그 대화 `title`도 같다 (BE e2e — FE가 종결 뒤 읽는 것은 목록이다)

**붙이지 않는 완결**

8. `route` 없는 `FAILED` 완결은 제목을 바꾸지 않는다 (BE e2e — 분류 전 실패. `title_source`도 `DEFAULT` 그대로다)
9. 수락은 여전히 제목을 바꾸지 않는다 (BE e2e — §51 기준 77 그대로. 수락 직후 `title`이 기본값임을 완결 전에 단언한다)
10. 이미 `AUTO`인 대화에 온 완결은 제목을 바꾸지 않는다 (BE e2e — 두 번째 턴의 질문은 제목이 아니다)
11. `USER` 제목 대화에 온 완결은 제목을 바꾸지 않는다 (BE e2e — PATCH로 이름을 바꾼 뒤 완결한다)
12. 구조화가 도는 동안 **`route` 없는 `CANCELLED`** 완결이 턴을 닫아 앞선 `COMPOSITE`·`COMPLETED` 완결이 409 `AGENT_TURN_CLOSED`로 지면 `title`은 기본값이다 (BE e2e — 환자 도구로 스냅샷을 고정하고 가짜 구조화기를 멈춰 둔 채 단언한다, §54 기준 28과 같은 방식. 제목이 종결과 같은 tx라 종결이 지면 함께 없다. 끼어드는 완결에 `route`를 실으면 그 완결이 제목을 붙여 판별력이 없다. **양성 대조**: 같은 fixture에서 끼어들기 없이 완결하면 제목이 선다. 이미 닫힌 턴은 `openTurn`이 tx 전에 409로 돌려보내므로 경합 없이는 이 성질을 관측할 수 없다)

**백필**

13. 마이그레이션 파일 `0029`의 UPDATE 문을 「기본 제목 + `route` 있는 에이전트 턴」 대화 시드 위에 실행하면 그 대화의 `title`이 첫 USER 메시지(40 코드포인트 규칙)이고 `title_source`가 `AUTO`다 (BE e2e — 전체 마이그레이션 뒤 파일의 문장을 다시 실행한다. 41자 이상 질문으로 단언)
14. 그때 두 번째 USER 메시지가 아니라 **첫** 메시지다 (BE e2e — 턴 둘인 대화로 단언)
15. 에이전트 턴이 없는 기본 제목 대화(메시지 0건)는 그대로다 (BE e2e)
16. `route` 없는 에이전트 턴만 있는 기본 제목 대화는 그대로다 (BE e2e — 런타임 규칙과 같은 경계)
17. `USER`·`AUTO` 제목 대화는 그대로다 — 각각 (BE e2e)

**공개 계약**

18. 커밋된 OpenAPI가 바뀌지 않는다 (BE contract)

fixture 규약:
- **BE e2e는 §13대로 Testcontainers**이고 §51 완결 스위트(`agent-turn-accept-finish.e2e-spec.ts`)의 방식 — 수락 뒤 내부 완결 API를 직접 부른다. LLM·에이전트를 부르지 않는다.
- **질문·답변은 구조를 모방한 합성 텍스트다** — 운영 질문을 쓰지 않는다. 라벨은 `CASE-<ulid>`처럼 합성이고, 기준 3·13의 긴 질문은 이모지 등 UTF-16 서로게이트 문자를 하나 이상 포함해 코드포인트 규칙을 단언한다.
- **백필 기준(13~17)은 `drizzle/migrations/0029_*.sql`을 파일로 읽어 `--> statement-breakpoint`로 나눈 문장을 시드 뒤 `pool.query`로 실행한다** — `migrate`는 이미 적용된 파일을 다시 돌리지 않으므로. UPDATE는 조건부라 재실행이 안전하다.
- **백필 시드는 완결 API로 만들지 않는다** — 구현 뒤에는 런타임이 이미 제목을 붙여 `DEFAULT`가 아니게 되고, 백필 규칙이 틀려도 기준 13·14가 공허하게 통과한다. 수락 API 뒤 SQL로 `agent_turns.route`를 채우거나(턴 둘이면 두 번 수락) 행을 직접 넣어, 실행 직전 `title_source`가 `DEFAULT`임을 먼저 단언한다.
- **회귀 가드**: §51 기준 77·85의 단언과 채팅 자동 제목 스위트를 바꾸지 않는다. §54 완결 스위트의 단언도 그대로다.
- **이 문서의 수치는 단언 대상이 아니다** — 9건·22턴은 운영의 상태다. 동결하는 것은 붙이는 조건(경로 있는 완결)·같은 tx·규칙의 동일성·백필의 경계다.

## Out of scope

- **라벨 제거·LLM 요약 제목** — 원문 그대로가 사용자 결정이다. 요약으로 올릴 때 `deriveConversationTitle`은 폴백으로 남는다(유틸 주석).
- **`route` 없는 완결(분류 전 실패)의 제목** — 수락 시점으로 옮기면 §51 기준 77을 재동결해야 한다. 운영 0건.
- **`title`의 암호화·검색 제외** — §4.5 경계 수용이 이 스펙의 전제다. 되돌리려면 이 스펙의 결정을 뒤집는 별도 스펙이다.
- **`titleSource`의 공개 노출** · **PATIENT_GUIDANCE 대화의 자동 제목**(§4.5 제외 그대로 — 운영은 FE가 생성 시 제목을 주어 40건 전부 `USER`다).
- **FE·AGENT 변경** — 없다(#117이 재조회를 이미 처리했다).
