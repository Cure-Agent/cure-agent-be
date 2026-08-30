# 43. 기권 사유 영속화 — 재조회에서도 사유별로 다르게 읽힌다

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> 완료된 spec은 커밋 로그처럼 기록으로 남을 뿐이므로, 이 디렉토리를 읽어 시스템을 이해하려 하지 말 것.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 e2e 테스트로 동결되며, 구현 중 수정할 수 없다.
> 스펙 결함 발견 시: spec을 먼저 고치고 테스트를 재동결한다 (사유를 커밋 메시지에).

## 목표

기권의 **사유가 메시지 행에 남아**, 스트림에서든 재조회에서든 세 사유가 각각 다르게 읽힌다.
사용자가 다음에 할 일 — 필터를 넓히거나 · 다른 것을 묻거나 · 질문을 좁히거나 — 이 화면에서 갈린다.

## 관측 (2026-08-30, 코드 대조)

§42가 `ABSTAIN_REASON_MESSAGE`에 3사유 × ko/en 6문장을 갖췄고 §42 기준 26·27이 그것을 단언하는데,
**그 문장이 화면에 닿는 경로가 없다.**

| 관측 | 위치 |
|---|---|
| 문장은 SSE `answer.abstained`의 `reason`으로만 나간다 — 일회성 채널이다 | `conversation-stream.service.ts:396` |
| 저장은 `status:'ABSTAINED', content:''` — **사유가 어디에도 남지 않는다** | 같은 파일 `:388`, `:644` |
| `MessageResponseDto`에 사유 필드가 없다 | `message.response.dto.ts` |
| FE는 스트림·재조회 **두 경로 모두** 고정 문구 1개를 그린다. 받은 `reason`은 상태에 저장만 되고 읽히지 않는다 | `chat-panel.tsx:285,399` · `stream-state.model.ts:153` |

**FE 단독으로는 못 고친다** — `status`는 `ABSTAINED` 하나뿐이라 세 사유를 가를 정보가 없다.
프로덕션 기권률 56%(35/63)라 이 문구가 영문 화면에서 가장 자주 노출된다.

**저장 지점은 하나가 아니라 둘이다.** 검색 게이트(`:388`, `no_candidates`·`beyond_cutoff`)는
`recordAbstain`을 **직접** 부르지만, 생성 게이트(`:644`, `insufficient_evidence`)는
`recordGenerationGate`만 부른다 — 기권 카운터는 그 안에서 대신 올라간다(`metrics.service.ts:399`,
「두 cause의 합 = `rag_abstains_total{insufficient_evidence}`」 불변식을 호출자 규율이 아니라 구조로
지키려는 의도적 설계). **집계 축은 멀쩡하므로 메트릭을 훑어서는 이 갈림이 드러나지 않고**,
`recordAbstain` 호출부를 따라가면 두 지점 중 하나만 나온다. 「`recordAbstain` 옆에 저장한다」로
잡으면 **`insufficient_evidence` 행이 영원히 null로 남아** 이 스텝이 고치려는 바로 그 뭉뚱그림이 남는다.

**FE 고정 문구는 BE 6문장 어느 것과도 자구가 다르다** — `'검색 조건에 해당하는 지침 근거를 찾지 못해
답변을 보류했습니다.'`(`messages.ts:23`)에는 BE 문장에 없는 「보류했습니다」가 있다.

## 판단 근거 (2026-08-30 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 문장을 저장하는가, 코드를 저장하는가 | **코드다.** 문장을 저장하면 ⑴ 오타를 고쳐도 과거 메시지는 옛 문장 그대로고 ⑵ 그 행은 영원히 저장 시점 언어이며 ⑶ 표현이 데이터에 굳어 나중에 CTA·아이콘을 붙일 수 없다. 부수 효과로 **기권 사유가 질의와 조인 가능한 데이터**가 된다 — 지금은 집계 카운터뿐이라 「어떤 질문이 어떤 사유로 기권했는지」를 행 단위로 볼 수 없다 |
| 어디서 문장으로 바꾸는가 | **`conversation.mapper.ts`가 직렬화 시점에.** `MessageRow`가 `abstain_reason`과 `response_lang`을 둘 다 들고 있으므로 `toMessageDto`의 **시그니처가 바뀌지 않는다** — 호출부(`conversation.service.ts:199`·`loadMessageDto`)를 건드리지 않는다 |
| 읽는 시점의 언어를 무엇이 정하는가 | **`messages.response_lang`(§42).** 이 스텝이 딛고 설 자리가 이미 있다 — 인용 번역이 재조회에서 살아남는 것과 **형태가 같은 문제**이고, §42 판단표 「재조회의 언어」가 그 축을 이미 만들어 뒀다 |
| 컬럼 타입 | **`pgEnum('abstain_reason', …)`.** `message_role`·`message_status`·`answer_kind`가 모두 pgEnum인 기존 규율을 따른다. `MessageRow['abstainReason']`이 `AbstainReason \| null`로 **타입이 공짜로 나와** 매퍼에 캐스팅·가드가 필요 없고, 알 수 없는 코드는 DB가 막는다 |
| SSE `reason`을 바꾸는가 | **그대로 둔다 — 계약 변경 0.** 저장이 `updateMessage`에서 일어나면 그 직후 `loadMessageDto`(`:392`·`:664`)가 이미 `abstainReason`이 실린 DTO를 돌려주므로 **이벤트의 `message`에도 같은 문장이 함께 나간다.** FE는 스트림이든 재조회든 `message.abstainReason` 하나만 보면 되고 두 경로가 저절로 일치한다 |
| `reasonCode`를 노출하는가 | **하지 않는다 — §42 판단표를 뒤집지 않는다.** 문구 소유권을 BE에 그대로 둔 채 문장이 재조회에서 살아남게만 한다. 옮길 때가 오면(셋째 언어 · 사유별 CTA) **컬럼이 이미 코드를 들고 있으므로 그 값을 DTO에 하나 더 싣기만 하면 된다.** 문장을 저장했다면 이 이행에 역매핑 마이그레이션이 필요했고, 문구가 한 번이라도 바뀌었으면 그마저 불가능하다 |
| 「보류」라는 사실은 누가 지는가 | **FE의 컨테이너가 진다 — 문구가 아니라 프레이밍이다.** BE 문장은 「무엇을 찾지 못했나」만 말하고 「그래서 답을 보류했다」를 말하지 않는데, §42 기준 27이 ko 자구를 잠갔으므로 BE 문구에 덧붙일 수 없다. amber notice 컨테이너가 이미 그 역할을 하고 있으므로 **사유 문장을 그 안에 넣는다** — 프레이밍은 유지되고 내용만 사유별로 갈린다 |
| 백필 | **하지 않는다 — 소스가 없다.** 사유가 어디에도 기록된 적이 없고 메트릭은 집계 카운터라 행 단위 복원이 불가능하다. 컬럼을 nullable로 두고 코드가 없으면 **DTO에 키를 싣지 않아** FE가 지금 문구로 폴백한다. 프로덕션 기권 35건이 여기 해당하며 영구적으로 일반 안내를 본다 — 데모 성격상 과거 대화 재열람이 드물어 감수한다 |

**위험.** ⑴ 저장 지점이 둘이라 한쪽만 고치면 `insufficient_evidence`가 조용히 null로 남는데,
**집계 축이 멀쩡해 메트릭으로는 드러나지 않는다** — 기준 3이 이것만을 위해 존재한다. ⑵ ko 사용자에게 보이는 문장이 오늘과 달라진다(「보류했습니다」가
빠진 BE 자구로 교체). 기준 19가 프레이밍 유지를 담보한다.

## 범위 (엔드포인트)

**신규·삭제 엔드포인트 없음.** 계약 변경은 `MessageResponseDto`에 `abstainReason?: string` 하나이고
additive다. `pnpm openapi:export` diff가 **이 한 필드의 추가뿐**이어야 한다(§1 contract 테스트가 지킨다).

| 진입점 (BE) | 변경 |
|---|---|
| `conversation.schema.ts` | `abstainReason` pgEnum + `messages.abstain_reason` 컬럼 |
| `drizzle/migrations/0024_message_abstain_reason.sql` (신규) | 아래 마이그레이션 |
| `conversation.repository.ts` | `updateMessage` patch 타입에 `abstainReason` 추가 (`Pick<MessageRow, 'content'\|'status'\|'abstainReason'>`) |
| `conversation-stream.service.ts` | **두 기권 경로가** 같은 `updateMessage`에 사유를 함께 저장(`:388` 검색 게이트 · `:644` 생성 게이트). `ABSTAIN_REASON_MESSAGE`를 mapper로 옮기고 import해 SSE `reason`에 계속 쓴다 |
| `conversation.mapper.ts` | 문구표를 소유하고, `toMessageDto`가 `row.abstainReason`·`row.responseLang`으로 렌더. **코드가 없으면 키를 싣지 않는다**(§42가 stale 번역에 쓴 규율과 같다) |
| `message.response.dto.ts` | `abstainReason?: string` |
| `docs/architecture.md` | §8에 `message.abstainReason` 한 줄, §9에 컬럼 |

| 진입점 (FE — `cure-agent-fe`) | 변경 |
|---|---|
| `ask-guideline/ui/chat-panel.tsx` | `AbstainedNotice`가 문장을 인자로 받는다 — 있으면 그 문장, 없으면 `t.abstainedNotice` 폴백. 컨테이너는 그대로 |
| `ask-guideline/model/stream-state.model.ts` | 스트림 경로도 `event.message.abstainReason`을 쓴다. `event.reason`은 읽지 않는다(두 경로 일치의 유일한 축을 하나로 둔다) |
| `shared/api/generated/schema.ts` | openapi 재생성 |

## Entity / 마이그레이션 변경분

- **`messages.abstain_reason`** — nullable `abstain_reason` enum(`no_candidates`·`beyond_cutoff`·
  `insufficient_evidence`). 백필 없음: null은 「기록되기 전에 만들어진 행」이라는 사실 그대로다.
  `AbstainReason`(`metrics.service.ts:42`)과 값이 같아야 하며, 그 타입이 원본이다.

## 추가 에러코드

없음 — 사유 부재는 오류가 아니라 **필드 부재**다.

## 수용 기준 (= 동결할 시나리오, Definition of Done)

**사유가 행에 남는다 — 두 게이트 모두**

1. `no_candidates` 기권 후 그 메시지 행의 `abstain_reason`이 `'no_candidates'`다 (BE e2e)
2. `beyond_cutoff` 기권 후 `'beyond_cutoff'`다 (BE e2e)
3. `insufficient_evidence` 기권 후 `'insufficient_evidence'`다 (BE e2e — **생성 게이트는 별도 저장 지점이다.** 검색 게이트만 고치면 이 기준만 실패한다)
4. `COMPLETED`로 끝난 답변의 `abstain_reason`이 null이다 (BE e2e)

**재조회가 사유별 문장을 싣는다**

5. `GET /conversations/{id}/messages`가 ABSTAINED 메시지에 `abstainReason` 문장을 싣는다 (BE e2e)
6. 세 사유가 재조회에서 **각각 다른 문장**이다 (BE e2e — 뭉뚱그림의 해소가 이 스텝의 목적)
7. `response_lang='en'`인 행은 **요청에 언어가 없어도** 영문 문장으로 실린다 (BE e2e — §42 기준 11과 같은 축)
8. `abstain_reason`이 null인 행은 `abstainReason` **키 자체가 응답에서 빠진다** (BE e2e — 빈 문자열을 싣지 않는다)
9. ABSTAINED가 아닌 메시지에는 그 키가 없다 (BE e2e)

**스트림과 재조회가 같은 문장을 낸다**

10. `answer.abstained` 이벤트의 `message.abstainReason`이 같은 메시지를 재조회한 값과 **자구까지 같다** (BE e2e — 두 경로 일치가 이 스텝의 목적이고, FE 고정 문구 없이 성립해야 한다)
11. `answer.abstained`의 `reason` 필드가 그대로 남고 `message.abstainReason`과 같은 문장이다 (BE e2e — 계약 회귀)

**기존 계약·문구가 그대로다**

12. `pnpm openapi:export` 재생성본과 커밋된 스펙의 차이가 **`MessageResponseDto.abstainReason` 추가뿐**이다 (BE — 기존 contract 테스트)
13. ko 세 문구가 §42 기준 27의 자구 그대로다 (BE 유닛 — 회귀)
14. en 세 문구가 §42 기준 26의 자구 그대로다 (BE 유닛 — 회귀)

**화면이 사유별로 다르게 읽힌다**

15. `abstainReason`이 실린 ABSTAINED 메시지를 재조회하면 **그 문장을** 렌더한다 (FE 유닛)
16. 스트림 `answer.abstained`도 `message.abstainReason`을 렌더한다 — 같은 메시지에서 두 경로가 같은 문장이다 (FE 유닛 — 기존 `chat-panel-abstained-restore.test.tsx`가 지키려던 일치를 고정 문구 없이 성립시킨다)
17. `abstainReason`이 없는 메시지는 기존 고정 문구로 폴백한다 (FE 유닛 — 프로덕션 35건의 경로)
18. 세 사유가 화면에서 **각각 다른 문장**이다 (FE 유닛)
19. 사유 문장이 기존 보류 안내와 **같은 컨테이너 안에** 렌더된다 (FE 유닛 — BE 문장에 「보류했습니다」가 없으므로 보류라는 사실은 프레이밍이 진다. 판단표 참조)

fixture 규약: e2e는 실 LLM을 부르지 않는다 — 세 기권 경로는 §40·§42 e2e가 이미 쓰는 방식(fake 게이트웨이의
판정 주입 · 필터로 후보 0건 · 거리 컷오프 초과)을 그대로 재사용한다. 기대 문장의 원천은 **§42 기준
26·27이 잠근 자구**이며, 구현의 `ABSTAIN_REASON_MESSAGE`를 읽어 기대값을 만들지 않는다 — 그러면 오라클이
구현을 따라가 무엇도 검증하지 못한다(§42 fixture 규약과 같은 이유).

## Out of scope

- **`reasonCode` 노출** — §42 판단표를 유지한다. 컬럼이 코드를 들고 있으므로 옮길 때가 오면 DTO에 값을
  하나 더 싣는 것으로 끝난다
- **기존 35건 백필** — 소스가 없다(판단표). null로 남고 FE가 폴백한다
- **메트릭 축 변경** — `rag_abstains_total{reason}`은 세 사유를 **이미 모두 센다**(생성 게이트는
  `recordGenerationGate` 안에서 올린다). 이 스텝은 **행 단위 사실**을 만들 뿐 집계 축을 건드리지
  않는다 — 「어떤 질문이 어떤 사유로 기권했는가」는 컬럼이 생긴 뒤 DB에서 센다
- **사유별 UI 분기** — 「필터 초기화」 버튼 같은 CTA·아이콘은 만들지 않는다. 사유별로 다른 **문장**까지가
  이번 범위다
- **ko 문구에 「보류」 복원** — §42 기준 27이 자구를 잠갔다. 프레이밍은 FE 컨테이너가 진다(판단표)
- **기권 사유의 관리자 조회 화면** — 컬럼이 생기면 질의와 조인 가능해지지만, 그것을 보는 화면은
  이 스텝이 만들지 않는다
