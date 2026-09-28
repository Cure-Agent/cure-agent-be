# 56. 환자 대화의 자동 제목 — 환자 맞춤 대화도 첫 질문으로 제목이 서고, 케이스 라벨이 그 앞에 남는다

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> 완료된 spec은 커밋 로그처럼 기록으로 남을 뿐이므로, 이 디렉토리를 읽어 시스템을 이해하려 하지 말 것.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 e2e 테스트로 동결되며, 구현 중 수정할 수 없다.
> 스펙 결함 발견 시: spec을 먼저 고치고 테스트를 재동결한다 (사유를 커밋 메시지에).

## 목표

환자 맞춤 대화(PATIENT_GUIDANCE)의 목록 제목이 오늘은 FE가 생성 시 굳힌 `CASE-001 임상 참고 (9/28 14:30)`으로
영영 남아, 같은 환자의 대화가 시각으로만 갈리고 무엇을 물었는지는 열어야 안다. 끝나면 **첫 질문이 수락되는 tx에서
`<케이스 라벨> · <첫 질문 40자>`**가 제목으로 서고(질문 부분은 채팅과 같은 `deriveConversationTitle`), 질문 전에는
케이스 라벨만이 기본 제목이며, 이미 남은 FE 틀 제목은 마이그레이션이 같은 규칙으로 채운다. 일반 대화(§55)의
규칙·제목은 바뀌지 않는다.

## 실측 조사 (2026-09-28, 운영 DB 읽기 전용 + BE·FE 코드)

| 확인 | 실측 |
|---|---|
| 막는 곳 | ⑴ FE가 생성 요청에 제목을 싣는다(`request-clinical-guidance.ts:37`, `buildGuidanceTitle`) → BE가 `title_source='USER'`로 굳힌다(`conversation.service.ts:82`) → 자동 제목은 `DEFAULT`에만 적중(`conversation.repository.ts:178`). ⑵ BE의 PATIENT_GUIDANCE 제외 2곳 — `conversation-stream.service.ts:247`(`autoTitle`)·`:352`(`applyAutoTitle` 가드). ⑶ architecture §4.5의 명시적 제외(§55가 GUIDELINE_QA 에이전트 대화만 수용) |
| 환자 대화 | 활성 26건(환자 15명) + 삭제 예약 14건 = 40건. **40건 전부 `USER`이고 전부 FE 틀**(`^.+ (임상 참고\|Clinical guidance) \(M/D H:MM\)$`) — 이름을 바꾼 대화 0건, 제목의 라벨이 현재 `case_label`과 다른 건 0건 |
| 첫 질문 | 활성 25건 중 **22건이 추천 질의문 원문**(`suggested-prompts.ts`, 진단마다 1문장이라 같은 문장이 5·4·4·3·2·2건). 라벨을 질문에 쓴 대화 **0건**. 질문 2개 이상인 대화 1건. 첫 질문 길이 26~263자(40자 이하 2건) — 영문 추천 질의문(117~263자)은 40자에서 잘린다 |
| 목록이 가진 것 | `ConversationSummaryResponseDto`에 `caseLabel`이 없다(`patientId`만) · 목록은 제목만 그리고 `lastMessagePreview`를 그리지 않는다(`conversation-list.tsx`) · 검색은 `title ILIKE`(`conversation.repository.ts:141`). **라벨이 제목에서 빠지면 환자를 알아보는 축과 검색 축이 함께 사라진다** |
| 라벨·길이 | `caseLabel`은 1~50자(`create-patient.request.dto.ts:22`), 제목 상한 100자(`update-conversation.request.dto.ts:8`) — `라벨 · 40자…`는 최대 50+3+41=94자로 안에 든다. 백필 모사 결과 37~52자 |
| 붙일 자리 | `stream()`은 PATIENT_GUIDANCE의 `patientId`를 이미 강제하고(`:531-533`) `PatientRepository.findById`가 클리닉 스코프·파기 제외로 라벨을 준다. 수락 tx·조건부 UPDATE·`deriveConversationTitle`은 그대로 쓴다 |
| 백필 모사 | 아래 U1의 SELECT — **38행**(활성 25 + 삭제 예약 13), U2 — **2행**(활성 1 + 삭제 예약 1). §29(`0029`)와 같이 `deleted_at`을 보지 않는다(파기가 지운다). 백필 뒤 활성 대화 중 제목이 같아지는 묶음 3개(6건) — 같은 환자에 같은 추천 질의문 |
| FE 표시 | `resolveConversationTitle`이 FE 틀을 정규식으로 되읽어 라벨 문구만 화면 언어로 다시 그린다(`conversation-title.ts:74-90`). 목록 재조회는 수락(`userMessageId`)·종결 두 시점 모두 있다(`chat-panel.tsx:211,245`) — 수락 tx에 붙이면 추가 이벤트 없이 보인다 |
| 동결된 이웃 | `test/clinical-guidance.e2e-spec.ts:371` 「PATIENT_GUIDANCE 대화는 첫 질문으로 제목을 자동 생성하지 않는다」(번호 없는 회귀 가드)가 이 스텝과 정면으로 어긋난다 — **이 스펙이 그 단언을 대체한다**(아래 fixture 규약) |

## 판단 근거 (2026-09-28 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 제목의 원천 | **`<caseLabel> · <deriveConversationTitle(첫 질문)>`.** 질문만 쓰는 안(일반 대화와 동일)은 기각 — 22/25가 추천 질의문 그대로라 목록에 같은 제목이 줄지어 서고, 목록 DTO에 라벨이 없어 환자를 못 알아보며 라벨 검색이 끊긴다. LLM 요약은 기각 — 비용·폴백·SQL 백필 불가(§55 Out of scope와 같다). 구분자 ` · `(U+00B7)는 라벨이 어디서 끝나는지를 사람과 검색 양쪽에 남긴다 |
| §4.5 경계 | **수용을 PATIENT_GUIDANCE까지 넓힌다 — 사용자의 명시적 선택이다.** 근거는 §55와 같다: 같은 질문이 이미 `messages.content`에 평문이고 이 대화의 검색 입력에는 프로필이 합성되지만 그것은 `title`이 아니라 `search_question`에 있다. 라벨은 비식별이고 이름·차트번호는 애초에 저장하지 않는다. 운영 25건의 첫 질문에 진단명·투약 **값**이 쓰인 예는 0건이다(위험은 성립하나 관측되지 않았다) |
| 어디서 | **채팅 수락 tx — GUIDELINE_QA 채팅과 같은 자리·같은 이유**(§55 판단표 「어디서」의 채팅 쪽). 답변이 실패·기권으로 끝나도 「대화한 사실」이 목록에 남고, 메시지 없이 제목만 남지 않으며, FE 수락 재조회가 그대로 받는다. 라벨은 수락 전에 `PatientRepository.findById`로 읽는다 — 환자가 파기됐으면 대화도 함께 파기돼 `findById(conversation)`가 먼저 404다 |
| 질문 전 기본 제목 | **케이스 라벨만**(`title_source='DEFAULT'`). FE가 제목을 싣지 않으면 BE가 생성 시 이 값을 넣는다. 「새 대화」로 두면 환자 대화가 목록에서 익명이 되고, 오늘의 FE 틀(시각 포함)을 BE가 물려받으면 i18n 문구가 BE로 들어온다. 언어 중립인 라벨이 유일하게 양쪽을 만족한다. 같은 환자의 두 빈 대화는 제목이 같다 — 질문하면 갈리고, 운영에 빈 환자 대화는 1건이다 |
| 생성 시 제목을 실은 요청 | **오늘과 같이 `USER`.** 계약을 바꾸지 않는다 — FE가 배포되기 전까지의 옛 FE 요청은 오늘처럼 동작한다(퇴행 없음). 제목을 굳히는 쪽은 FE의 변경(제목을 빼는 것)이다 |
| 백필 | **한다 — `0030`, UPDATE 2문.** U1: `USER`·PATIENT_GUIDANCE·FE 틀 제목·첫 USER 메시지 있음 → `현재 case_label · 40자 규칙`, `AUTO`. U2: FE 틀 제목·USER 메시지 없음 → `현재 case_label`, `DEFAULT`(다음 첫 질문이 규칙대로 붙도록). 라벨은 제목에서 캡처하지 않고 **현재 `patients.case_label`**을 쓴다 — 런타임과 같은 원천이다(운영 불일치 0건). FE 틀과 다른 `USER` 제목은 사람의 이름이라 건드리지 않는다(운영 0건). `deleted_at`은 §29와 같이 보지 않는다. 기대 갱신 **38 + 2행** |
| 제목 중복 | **감수한다.** 같은 환자에 같은 추천 질의문으로 시작한 대화(활성 3묶음 6건)는 제목이 같아진다 — 목록은 최근순이고 시각을 제목에 두는 오늘의 방식도 답을 보여 주지는 못했다. `lastMessagePreview` 표시는 FE의 별도 결정이다 |
| FE 되읽기 | **제거한다.** 백필 뒤 FE 틀 제목은 남지 않고(사람이 같은 모양으로 지은 이름은 그 사람의 이름이다), `buildGuidanceTitle`·`guidanceTitleTemplate`·`retranslateGuidanceTitle`은 쓰는 곳이 없어진다. `새 대화` 자리표시자 치환은 그대로다 |

**위험.**
- ⑴ **§4.5 값이 평문 `title`에 실릴 수 있다**(수용, §55 ⑴과 같다) — 이제 환자 대화까지다. 클리닉 구성원 누구나 보는 자산이다(§5.7).
- ⑵ **BE만 배포된 구간**에는 옛 FE가 여전히 제목을 실어 오늘처럼 `USER`로 남는다 — 그 구간의 대화는 백필이 이미 돌았으므로 FE 틀 제목이 다시 생긴다. **FE 배포 뒤 `0030`의 SELECT를 한 번 더 읽어 0행임을 확인**한다(배포 후 확인 ③). 0행이 아니면 같은 문장을 손으로 다시 돌린다(조건부라 안전하다).
- ⑶ **백필은 되돌리지 않는다**(§55 ⑶과 같다).

## 범위 (엔드포인트)

**공개 BE 엔드포인트 신규·변경 없음 — OpenAPI diff 0.** `POST /conversations`의 `title` 선택 필드는 그대로이고, 응답 `title`은 string이다.

| 진입점 (BE) | 변경 |
|---|---|
| `src/domain/conversation/service/conversation.service.ts` | PATIENT_GUIDANCE 생성에서 `dto.title`이 없으면 `title = 환자의 caseLabel`, `titleSource = 'DEFAULT'`(환자는 이미 `patientService.detail`로 읽는다). GUIDELINE_QA는 그대로 `DEFAULT_TITLE` |
| `src/domain/conversation/service/conversation-stream.service.ts` | `stream()` — PATIENT_GUIDANCE도 `autoTitle: true`, 수락 전에 `PatientRepository.findById`로 라벨을 읽어 접두로 넘긴다. `applyAutoTitle` — 타입 가드를 없애고 PATIENT_GUIDANCE면 `` `${caseLabel} · ${derived}` ``, 아니면 `derived`. `:315-331` 주석의 PATIENT_GUIDANCE 제외 문단을 「§4.5 수용, 라벨 접두」로 개정 |
| `src/domain/conversation/service/conversation-title.util.ts` | 접두 조립 헬퍼(질문 부분의 규칙은 그대로 — SQL 구현이 셋이 된다는 주석 갱신) |
| `drizzle/migrations/0030_patient_conversation_title_backfill.sql` (신규) | 아래 마이그레이션 |
| `docs/architecture.md` | §4.5 `title` 평문 문단 — PATIENT_GUIDANCE 제외를 「라벨 접두로 수용(docs/specs/56)」으로 · §5.6 환자 기반 대화 생성 행에 「제목은 BE가 라벨로 두고 첫 질문이 완성한다」 한 줄 · §5.7 자동 제목 문단에 환자 대화 규칙 한 줄 |

| 진입점 (FE — cure-agent-fe) | 변경 |
|---|---|
| `src/features/request-clinical-guidance/api/request-clinical-guidance.ts` | 생성 요청에서 `title`을 뺀다. `caseLabel` 입력이 필요 없어지면 인자에서도 뺀다(`patient-detail-panel.tsx` 호출부 함께) |
| `src/features/request-clinical-guidance/lib/guidance-title.ts` (+ test) | 삭제 |
| `src/features/manage-conversation/lib/conversation-title.ts` (+ test) | `retranslateGuidanceTitle`·`ConversationKind` 인자 제거 — `새 대화` 치환만 남는다. `conversation-list.tsx`의 `displayTitle`이 `type`을 넘기지 않아도 된다 |
| `src/shared/i18n/messages.ts` | `guidanceTitleTemplate`(ko·en)와 그 양방향 주석 삭제 |
| `src/features/request-clinical-guidance/ui/request-guidance-button.test.tsx` | fixture 제목을 라벨만으로 |

**배포 후 확인 (동결 밖)**
- ① BE 배포 뒤 `SELECT count(*) FROM conversations WHERE type='PATIENT_GUIDANCE' AND title_source='USER' AND title ~ '<FE 틀>'` — 0 (작성 시점 대상 40건 = U1 38 + U2 2. 건수가 아니라 불변식으로 본다).
- ② 운영에서 환자 상세 → 대화 시작 → 목록 제목이 라벨만이다 → 추천 질의문 전송 → 수락 직후 목록 제목이 `라벨 · 질문…`이다. 새로고침해도 같다. 목록 검색에 라벨을 넣으면 그 대화가 나온다.
- ③ FE 배포 뒤 ①을 다시 읽는다(위험 ⑵).

## Entity / 마이그레이션 변경분

- 컬럼·인덱스 없음. `0030` — UPDATE 2문(`--> statement-breakpoint`로 나눈다).
  - **U1**: `0029`의 `DISTINCT ON (conversation_id) … ORDER BY id` 첫 USER 메시지 + `btrim(regexp_replace(content,'\s+',' ','g'))` + `char_length > 40 → left(…,40)||'…'`를 **`p.case_label || ' · ' ||`** 뒤에 붙인다(`JOIN patients p ON p.id = c.patient_id`). 조건 `c.type='PATIENT_GUIDANCE' AND c.title_source='USER' AND c.title ~ '^.+ (임상 참고|Clinical guidance) \(\d{1,2}/\d{1,2} \d{1,2}:\d{2}\)$' AND cleaned <> ''`. `title_source='AUTO'`.
  - **U2**: 같은 타입·출처·틀 조건 + `NOT EXISTS (USER 메시지)` → `title = p.case_label`, `title_source='DEFAULT'`.
  - 두 문장 모두 재실행이 안전하다(틀 조건이 갱신 뒤엔 거짓이다).

## 추가 에러코드

- 없음 — 공통 코드로 충분.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

**생성 — 질문 전 기본 제목**

1. `POST /conversations {type: PATIENT_GUIDANCE, patientId}`(제목 없음)의 응답 `title`이 그 환자의 `caseLabel`이다 (BE e2e)
2. 그때 `conversations.title_source`가 `DEFAULT`다 (BE e2e — DB 직접 단언)
3. 제목을 실은 PATIENT_GUIDANCE 생성은 오늘과 같이 그 제목·`USER`다 (BE e2e — 옛 FE 요청의 퇴행 없음)
4. GUIDELINE_QA 생성의 기본 제목은 오늘 그대로다 (BE e2e — `conversation.e2e-spec.ts` 기준 1의 단언을 바꾸지 않는다)

**첫 질문이 제목을 완성한다** (PATIENT_GUIDANCE 채팅 스트림 — `clinical-guidance.e2e-spec.ts`의 fake 파이프라인 방식)

5. 기본 제목 대화에 40 코드포인트 이하 질문이 완료되면 `GET /conversations/{id}`의 `title`이 `` `${caseLabel} · ${질문}` ``이다 (BE e2e)
6. 그때 `title_source`가 `AUTO`다 (BE e2e)
7. 41 코드포인트 이상 질문이면 질문 부분이 앞 40 코드포인트 + `…`이고 라벨 접두는 그대로다 (BE e2e — BMP 밖 문자를 포함해 단언한다, §55 기준 3과 같은 이유)
8. 질문의 개행·연속 공백은 한 칸으로 접힌다 (BE e2e)
9. 두 번째 질문은 제목을 바꾸지 않는다 (BE e2e — 조건부 UPDATE, §55 기준 10과 같은 이유)
10. 답변이 `error`로 끝나도 제목은 선다 (BE e2e — 수락 시점 규칙, §55 기준 6과 같은 이유. fake LLM이 던진다)
11. `GET /conversations` 목록의 `title`도 같다 (BE e2e)
12. `GET /conversations?query=<caseLabel>`이 그 대화를 돌려준다 (BE e2e — 라벨 검색 축 보존)
13. 첫 질문 전에 `PATCH`로 이름을 바꾼 대화(`USER`)는 첫 질문 뒤에도 그 이름이다 (BE e2e — §55 기준 11과 같은 이유)
14. GUIDELINE_QA 채팅의 자동 제목에는 접두가 붙지 않는다 (BE e2e — 회귀 가드, 기존 스위트 단언을 바꾸지 않는다)

**백필** (`drizzle/migrations/0030_*.sql`을 파일로 읽어 시드 뒤 실행)

15. `USER` + 한국어 FE 틀 제목(`CASE-x 임상 참고 (8/4 14:30)`) + 첫 USER 메시지(41 코드포인트 이상)인 PATIENT_GUIDANCE 대화가 `` `${현재 caseLabel} · 앞 40…` ``·`AUTO`가 된다 (BE e2e — 실행 직전 `USER`임을 먼저 단언)
16. 영어 FE 틀 제목(`CASE-x Clinical guidance (8/4 14:30)`)도 같다 (BE e2e)
17. 질문이 둘이면 **첫** 메시지다 (BE e2e)
18. FE 틀 제목이지만 USER 메시지가 없는 대화는 `title = 현재 caseLabel`·`DEFAULT`가 된다 (BE e2e)
19. 제목의 라벨이 옛 라벨이고 환자의 `caseLabel`이 그 뒤 바뀐 대화는 **현재** 라벨로 선다 (BE e2e — `PATCH /patients/{id}`로 라벨을 바꾼 뒤 실행)
20. FE 틀과 다른 `USER` 제목(예: `CASE-x 재검토`)은 그대로다 (BE e2e)
21. 같은 틀의 제목을 가진 GUIDELINE_QA 대화는 그대로다 (BE e2e — 타입 경계)
22. 이미 `AUTO`·`DEFAULT`인 PATIENT_GUIDANCE 대화는 그대로다 (BE e2e)

**공개 계약**

23. 커밋된 OpenAPI가 바뀌지 않는다 (BE contract)

**화면**

24. 환자 맞춤 대화 시작 요청의 body에 `title`이 없다 (FE 유닛 — `useRequestClinicalGuidance`의 POST body 단언)
25. `resolveConversationTitle('CASE-001 · 합성 질문…', 'en')`과 `('CASE-001', 'en')`은 입력 그대로다 (FE 유닛)
26. `resolveConversationTitle('CASE-001 임상 참고 (8/4 14:30)', 'en', 'PATIENT_GUIDANCE')`은 **더 이상 되읽지 않고 그대로다** (FE 유닛 — 오늘은 `Clinical guidance`로 바뀌므로 양성 대조가 된다. 시그니처에서 `kind`를 뺐다면 두 인자로 단언)
27. `새 대화`의 화면 언어 치환은 그대로다 (FE 유닛 — 기존 테스트를 바꾸지 않는다)

fixture 규약:
- **BE e2e는 §13대로 Testcontainers**, 환자·대화·스트림은 `clinical-guidance.e2e-spec.ts`의 방식(fake LLM·리랭커·임베딩). 라벨은 `CASE-<ulid 끝 6자>`처럼 합성이고, 질문·답변은 **구조를 모방한 합성 텍스트**다 — 운영 질문·추천 질의문 원문을 쓰지 않는다. 기준 7·15의 긴 질문은 UTF-16 서로게이트 문자를 하나 이상 포함한다.
- **백필 시드는 `PATCH /conversations/{id} {title: <FE 틀 문자열>}`로 만든다** — 그것이 `USER` + 틀 제목을 만드는 유일한 공개 경로이고, 그 뒤 스트림 API로 질문을 넣어도 런타임 규칙은 `USER`라 붙지 않는다(§55 fixture 「백필 시드는 완결 API로 만들지 않는다」와 같은 이유로 실행 직전 `USER`를 먼저 단언). 파일은 `--> statement-breakpoint`로 나눠 `pool.query`로 실행한다 — `migrate`는 적용된 파일을 다시 돌리지 않는다.
- **대체되는 단언**: `test/clinical-guidance.e2e-spec.ts:371` 「PATIENT_GUIDANCE 대화는 첫 질문으로 제목을 자동 생성하지 않는다」는 번호 없는 회귀 가드이고 이 스펙의 기준 5·6이 그 반대를 단언한다. **Phase 2에서 그 테스트를 삭제하고 사유를 커밋 메시지에 남긴다**(§55 회귀 가드 규약의 예외 — 스펙이 결정을 뒤집었다). `conversation.e2e-spec.ts`의 GUIDELINE_QA 자동 제목 단언과 §55 스위트는 바꾸지 않는다.
- **FE 유닛은 vitest**, `conversation-title.test.ts`·`request-guidance-button.test.tsx`를 고치고 `guidance-title.test.ts`는 파일과 함께 지운다. FE에는 새 표시 로직이 없다 — 저장된 제목을 그대로 그린다.
- **이 문서의 수치는 단언 대상이 아니다** — 40건·38+2행·3묶음은 운영의 상태다. 동결하는 것은 규칙(라벨 · 40자)·자리(수락 tx)·기본 제목(라벨)·백필의 경계다.

## Out of scope

- **LLM 요약 제목·라벨 제거** — §55 Out of scope 그대로. `deriveConversationTitle`은 폴백으로 남는다.
- **제목 중복 해소**(같은 환자·같은 질문) — `lastMessagePreview`를 목록에 그리는 것은 FE의 별도 결정이다.
- **`title`의 암호화·검색 제외** — 이 스펙은 §4.5 수용을 환자 대화까지 넓힌 것이다. 되돌리려면 §55와 이 스펙의 결정을 함께 뒤집는 별도 스펙이다.
- **라벨 변경의 제목 추종** — 환자의 `caseLabel`을 바꿔도 이미 붙은 제목은 그대로다(사용자가 지은 이름과 같은 취급). 백필만 현재 라벨을 쓴다.
- **에이전트 턴** — PATIENT_GUIDANCE 대화는 에이전트를 받지 않는다(§5.7). 일반 대화의 환자 경로 제목(§55)은 라벨 접두 없이 질문 원문 그대로이며 바뀌지 않는다.
- **`titleSource`·`caseLabel`의 목록 DTO 노출** — 계약 변경이라 별도 스펙이다.
