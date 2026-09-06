# 47. 큰 프레임의 꼬리가 대기 화면을 삼킨다 — 도착 순서를 계약으로 되찾는다

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> 완료된 spec은 커밋 로그처럼 기록으로 남을 뿐이므로, 이 디렉토리를 읽어 시스템을 이해하려 하지 말 것.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 e2e 테스트로 동결되며, 구현 중 수정할 수 없다.
> 스펙 결함 발견 시: spec을 먼저 고치고 테스트를 재동결한다 (사유를 커밋 메시지에).

## 목표

§46이 연 진행 단계 중 **마지막 창(`answer.started`)이 프로덕션에서 0ms**다. 근거 카드도 답변 본문과
같은 순간에 뜬다. 원인은 §46이 추정한 「작은 프레임이 앞선 꼬리를 밀어낸다」가 **성립할 수 없기
때문**이다 — 같은 스트림에서 뒤에 쓴 30B는 앞의 32KB를 앞지를 수 없다.

**도착 순서를 네트워크 운에 맡기지 않고 발신 순서로 결정한다.** 작은 프레임을 큰 프레임 **앞**에
두고, 큰 프레임을 **쪼개 일찍 도착한 바이트가 쓸모 있게** 만든다.

## 실측 조사 (2026-09-06, prod cure.demo01.xyz — #418 배포 후, 표본 2)

브라우저에서 `fetch`로 SSE를 직접 열어 **청크 도착 시각과 프레임 완결 시각을 함께** 기록했다.

### 표본 1 — 만성 요통 (답변 성공)

| 프레임 | 도착 | chunk | 크기 |
|---|---:|---:|---:|
| `message.accepted` + `retrieval.started` | 73ms | #0 | 278B |
| `retrieval.progress` embedded | 645ms | #1 | 61B |
| `retrieval.progress` searched (후보 59) | 896ms | #2 | 77B |
| `retrieval.progress` reranked | 2,323ms | #3 | 53B |
| `retrieval.completed` | **3,222ms** | #6 | **~32KB** |
| `answer.started` | **3,222ms** | #6 | 30B |
| 첫 `answer.delta` | **3,222ms** | #6 | 89B |

청크: `#3 8,180B @2,323` → `#4 4,096B @2,326` → `#5 12,288B @2,328` → **894ms 정지** → `#6 7,655B @3,222`

### 표본 2 — 불면증 (생성 게이트 ④ 기권)

`#3 8,180B @2,721` → **773ms 정지** → `#4 5,752B @3,494` = `retrieval.completed`(13,379B) 완결 +
`answer.started` + `answer.abstained`

### 이 실측이 확정한 것

- **작은 프레임은 예외 없이 즉시 도착한다.** 53·61·77·278B가 전부 자기 청크로 왔다(6/6).
- **큰 프레임의 마지막 부분 블록은 다음 write까지 갇힌다.** 정지 894ms·773ms는 각각 그 요청의
  TTFT와 같다. `answer.started`는 그 꼬리 **안에** 있으므로 함께 갇힌다 — 재현율 2/2.
- **§46의 처방은 반증됐다.** 30B를 뒤에 써서 앞의 꼬리를 밀 수는 없다. 위험 ⑴이 위험이 아니라
  구조적 불가능이었고, RTT 0인 로컬 재현이 그것을 가릴 수 있었다.
- **이미 도착한 바이트가 쓸모없이 버려진다.** 표본 1은 `t=2,328`에 32KB 중 **24.5KB(≈75%)**를
  이미 받아두고도 프레임이 종결되지 않아 근거를 한 건도 그리지 못했다.

### 화면 창 실측 (§46 문구 기준)

| 문구 | 표본1 | 표본2 |
|---|---:|---:|
| 진행 이벤트 전 (「지침 근거를 검색하는 중」) | 572ms | 1,040ms |
| embedded (「지침을 검색하는 중」) | **251ms** | **340ms** |
| searched (「후보 N건에서 고르는 중」) | 1,427ms | 1,283ms |
| reranked (「근거를 정리하는 중」) | 899ms | 773ms |
| `answer.started` (「답변을 작성하는 중」) | **0ms** | **0ms** |

§46이 연 네 창 중 셋은 살아 있다. 죽은 것은 마지막 하나다.

## 판단 근거 (2026-09-06 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| `answer.started`를 지우는가 | **아니다 — 앞으로 옮긴다.** 이 이벤트는 문구 공급원이기 전에 **생성 게이트(④) 기권과 검색 게이트(①~③) 기권을 가르는 유일한 경계**다(§8). 창이 0ms인 것은 이벤트의 결함이 아니라 발신 위치의 결함이고, 위치는 한 줄로 고쳐진다. 지우면 증상(근거 카드 = 답변)은 그대로인 채 관측 축만 잃는다 |
| 어디로 옮기는가 | **리랭크 블록 직후 · 번역 조회 이전.** `abstainReason`이 그 시점에 이미 확정돼 있어 ①~③ 기권 배제 조건이 그대로 유지되고, 번역 DB 조회(§42)보다도 앞서므로 창이 그만큼 더 넓다. 이 자리로 오면 「LLM 호출 직전」이 아니라 **「검색 게이트를 통과해 답변 생성으로 넘어간다」**는 경계가 된다 — 실제로 그것이 이 이벤트가 화면에 말하는 사실이다 |
| `evidenceCount`를 싣는가 | **싣는다.** 순서를 뒤집으면 `retrieval.completed`가 아직 안 와서 FE의 「지침 근거 N건을 바탕으로」의 N이 0이 된다. 정수 하나라 프레임은 60B 미만으로 유지되고, 「evidence를 싣지 않는다」(§46 기준 10)의 **취지**(작아서 즉시 도착)는 그대로다 |
| 근거 카드 지연을 어떻게 고치는가 | **evidence를 프레임당 1건으로 쪼갠다.** 꼬리 지연 자체는 네트워크의 성질이라 없앨 수 없다 — 우리가 바꿀 수 있는 것은 **일찍 도착한 바이트가 완결된 프레임인가**뿐이다. 표본 1 기준 32KB/5 ≈ 6.4KB이므로, 정지 시점(`t=2,328`)까지 도착한 24.5KB 안에 3~4건이 **완결된 채로** 들어 있게 된다 |
| 그래도 마지막 1~2건은 늦지 않는가 | **늦는다. 그것이 이 스펙이 약속하는 전부다.** 「꼬리가 사라진다」고 쓰지 않는다 — §46이 정확히 그렇게 써서 틀렸다. 약속은 **점진 렌더**이지 지연 제거가 아니다 |
| `retrieval.completed`에 evidence를 남기는가 | **아니다 — 비운다.** 남기면 32KB 프레임이 그대로라 꼬리가 `retrieval.completed` **이후 전부**(첫 델타 포함)를 계속 밀어낸다. 쪼갠 의미가 없다 |
| 배포 순서 | **FE가 먼저다 — §46과 반대다.** §46은 additive라 BE 선배포가 안전했지만, 이번은 `retrieval.completed.evidence`를 **없애는** 변경이라 구버전 FE가 카드를 통째로 잃는다. FE가 두 형태를 모두 읽을 수 있게 된 뒤에 BE를 올린다 |
| 대기 문구 축을 손보는가 | **손본다.** 진행 이벤트 전 구간에 실제로 도는 것은 **질의 임베딩**인데 문구가 「지침 근거를 검색하는 중」이라 검색이라고 말한다. 그래서 embedded 문구(「지침을 검색하는 중」)와 두 글자 차이가 되고, 실측 251~340ms 창에서는 바뀐 것을 인지할 수 없다 |
| 그러면 §46 기준 29는 | **개정한다.** 「구버전 BE에서도 오늘의 문구로 동작한다」는 진행 이벤트가 아직 계약이 아니던 때의 안전망이다. 지금은 배포됐고 남은 것은 롤백 시나리오뿐이라, 그때 문구가 부정확해지는 것을 감수한다 |
| 임계를 상수로 박는가 | **아니다.** 정지 경계는 표본 1이 24.5KB, 표본 2가 8.1KB로 갈렸다 — 소켓 상태에 의존하므로 「8KB 미만이면 안전」은 우리가 보증할 수 없는 문장이다. 계약은 **프레임을 근거 단위로 쪼갠다**까지이고, 바이트 임계는 적지 않는다 |

**위험.** ⑴ 점진 렌더는 카드가 **한 건씩 나타나는** 화면이 된다 — 지금의 「5건이 한 번에」와 다른
인상이라 FE가 자리를 미리 잡아둘지(스켈레톤) 여부를 정해야 한다. ⑵ FE 선배포 구간에는 두 경로가
공존한다 — 구버전 BE의 `retrieval.completed.evidence`와 신규 `retrieval.evidence`가 **동시에**
오지는 않지만, FE는 둘 다 받을 수 있어야 한다. ⑶ 이 스펙의 효과는 **e2e가 잴 수 없다**(도착 시각은
prod 네트워크의 성질이다) — 동결하는 것은 발신 순서와 프레임 구조뿐이고, 효과 확인은 배포 후
위와 같은 브라우저 실측으로 한다.

## 범위 (엔드포인트)

**엔드포인트 신규·삭제 없음.** `POST /conversations/{id}/messages/stream`의 SSE 이벤트 계약이 바뀐다 —
`retrieval.evidence` 신규 1종, `answer.started` 발신 위치·페이로드 변경, `retrieval.completed`에서
`evidence` 제거.

| 진입점 (BE) | 변경 |
|---|---|
| `conversation-stream.service.ts` | ⑴ `answer.started`를 리랭크 블록 직후·번역 조회 이전으로 이동(`!abstainReason`일 때만) + `evidenceCount` 탑재, 기존 `generateAnswer` 내 발신 제거 ⑵ 근거 1건당 `retrieval.evidence` 발신 ⑶ `retrieval.completed`에서 `evidence` 제거 |
| `conversation.controller.ts` | `@ApiOperation` description — 이벤트 순서·신규 이벤트·`answer.started` 페이로드 (`openapi/`는 `pnpm codegen` 산출) |
| `docs/architecture.md` §8 | `ConversationStreamEventDto` 유니온 갱신 + 「`answer.started`는 아무것도 싣지 않는다」 규약 개정 + ④ 기권의 근거 전달 경로 갱신(577행) |

| 진입점 (FE — cure-agent-fe) | 변경 |
|---|---|
| `src/features/ask-guideline/model/stream-state.model.ts` | `retrieval.evidence` 누적 배선, `answer.started`의 `evidenceCount` 보존, `retrieval.completed`의 evidence 부재 허용(구버전 BE 호환 유지) |
| `src/features/ask-guideline/ui/chat-panel.tsx` | `waitingLabel`이 `evidenceCount`를 우선 사용, 근거 카드 점진 렌더 |
| `src/shared/i18n/messages.ts` | 진행 이벤트 전 구간 문구를 embed 구간에 맞게 교체 (ko·en) |

## Entity / 마이그레이션 변경분

- 없음 — 스트림 전송 계약만 바뀐다. 영속화 대상이 아니다.

## 추가 에러코드

없음 — 프레임 분할은 실패 경로를 만들지 않는다. 발신 실패는 스트림 자체의 실패로 이미 드러난다.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

**`answer.started`가 큰 프레임 앞에 선다**

1. 해피패스에서 `answer.started`가 `retrieval.progress(stage=reranked)` **뒤**, `retrieval.completed` **앞**에 발신된다 (BE e2e — §46 기준 9를 대체한다)
2. `answer.started`가 `evidenceCount`에 최종 근거 수를 싣는다 (BE e2e)
3. `answer.started`는 evidence 배열을 싣지 않는다 (BE e2e — §46 기준 10 유지)
4. 검색 게이트(①~③) 기권은 `answer.started`를 발신하지 않는다 — 근거 0건·거리 컷·점수 컷 3경로 모두 (BE e2e — §46 기준 12·13·14)
5. 생성 게이트(④) 기권은 `answer.started`가 **이미 발신돼 있다** (BE e2e — §46 기준 11)
6. 리랭크가 꺼진 구성에서도 `answer.started`가 `retrieval.completed` 앞에 온다 (BE e2e)

**근거가 프레임 단위로 도착한다**

7. `retrieval.evidence`가 근거 1건당 1개 발신된다 (BE e2e)
8. `index`는 0부터 연속이고 `total`은 모든 이벤트에서 같다 (BE e2e)
9. `retrieval.evidence`의 순서가 오늘 `retrieval.completed`가 싣던 배열 순서와 같다 (BE e2e — 리랭크 순위가 보존된다)
10. `retrieval.evidence.evidence`의 필드가 오늘 배열 원소와 같다 (BE e2e — 같은 매퍼를 탄다)
11. `retrieval.completed`는 `evidence`를 싣지 않는다 (BE e2e)
12. 모든 `retrieval.evidence`가 `retrieval.completed` **앞**에 온다 (BE e2e)
13. 검색 게이트 기권(①~③)은 `retrieval.evidence`를 하나도 발신하지 않는다 (BE e2e)
14. 생성 게이트(④) 기권은 `retrieval.evidence`를 정상 발신한다 (BE e2e — §8 「④는 근거를 싣는다」의 대체)
15. `responseLang≠ko`에서 번역이 실린 근거가 같은 형태로 온다 (BE e2e — §42 회귀)

**기존 계약이 그대로다**

16. `message.accepted`·`retrieval.started`·`retrieval.progress`·`answer.delta`·`answer.completed`·`answer.abstained`·`error`의 **필드가 하나도 바뀌지 않는다** (BE e2e)
17. `retrieval.progress`가 `embedded` → `searched` → `reranked` 순서로 계속 발신된다 (BE e2e — §46 기준 1~8 회귀)
18. `answer.delta`의 `seq`는 여전히 0부터 연속이다 (BE e2e)
19. 스트림 실패 시 `error` + `FAILED`, 클라이언트 abort 시 `CANCELLED` 정리가 그대로다 (BE e2e — §8-4·8-6 회귀)
20. 첫 `answer.delta`가 나간 요청만 `llm_time_to_first_token_seconds{provider}`를 1회 관측한다 (BE e2e — §46 기준 20·21 회귀)

**화면이 근거를 받는 대로 그린다**

21. `retrieval.evidence`를 받으면 `index` 순으로 근거 카드를 누적 렌더한다 (FE 유닛)
22. `retrieval.completed`에 evidence가 없어도 이미 받은 카드가 유지된다 (FE 유닛)
23. `retrieval.completed`가 evidence를 실은 구버전 BE에서도 카드가 뜬다 (FE 유닛 — **FE 선배포 구간의 안전이 이 한 줄에 걸려 있다**)
24. `answer.started`의 `evidenceCount`로 「지침 근거 N건을 바탕으로」의 N을 채운다 (FE 유닛 — 이 시점에 evidence 배열은 아직 비어 있다)
25. `answer.started` 도착 시 `phase`가 `generating`이 되고 본문 영역을 렌더하지 않는다 (FE 유닛 — §46 기준 24·25 회귀)
26. 첫 `answer.delta`에서 `phase`가 `streaming`으로 올라간다 (FE 유닛 — §46 기준 26 회귀)

**대기 문구가 실제 구간을 말한다**

27. 진행 이벤트 도착 전 대기 문구가 embed 구간을 말하는 문구다 — embedded 문구와 **서로 다른 문자열**이다 (FE 유닛 — §46 기준 29를 대체한다)
28. 새 문구가 ko·en 양쪽에 있다 (FE 유닛 — §42·§44와 같은 이유)
29. 모르는 `eventType`·모르는 `stage`를 받아도 상태가 바뀌지 않는다 (FE 유닛 — 회귀)
30. 경과 시간 표시(PR #107)가 단계 전환과 무관하게 이어진다 (FE 유닛 — 회귀)

fixture 규약: e2e는 **실 코퍼스도 실 프로바이더도 부르지 않는다.** 청크는 구조를 모방한 합성
텍스트를 적재하고(§13), LLM·리랭커·임베더는 결정적 fake를 쓴다. 기대값 원천은 **이 문서의 순서
규약**이지 구현의 상수가 아니다. **이 문서의 시간 수치(894ms·TTFT 0.76초·창 251ms 등)는 prod
네트워크와 외부 API의 성질이므로 e2e의 단언 대상이 아니다** — 동결하는 것은 **발신 순서와 프레임
구조**다.

## Out of scope

- **꼬리 지연 자체를 없애는 것** — 소켓·프록시 계층의 성질이고 계층을 특정하지도 못했다(정지 경계가
  표본마다 8.1KB·24.5KB로 갈렸다). 이 스텝은 **일찍 도착한 바이트를 쓸모 있게** 만들 뿐이다.
- **대기를 줄이는 것** — 실측상 표적은 리랭크(1,283~1,427ms)와 embed(572~1,040ms)로 둘 다 외부 API
  호출이고, §45가 `keyword_search`에 한 것과 같은 별건의 조사가 필요하다.
- **문구 전환의 최소 표시 시간** — embedded 창이 251ms인 것은 검색이 그만큼 빠르다는 사실 자체다.
  깜빡임 억제는 화면 소유이고 이 계약이 정할 것이 아니다.
- **SSE 이벤트의 생성 스키마화** — description과 §8은 갱신하지만 `openapi/`·`generated/`의 oneOf +
  discriminator 표현은 손으로 고치지 않는다(§1). §46과 같은 판단이다.
- **끊김 복구 계약의 변경** — 근거 프레임은 상태를 만들지 않으므로 재조회 기준점(`message.accepted`의
  `assistantMessageId`)이 그대로다.
