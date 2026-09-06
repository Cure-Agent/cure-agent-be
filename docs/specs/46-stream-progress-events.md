# 46. 답변 SSE가 진행 단계를 실시간으로 알린다 — 대기를 경계로 쪼갠다

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> 완료된 spec은 커밋 로그처럼 기록으로 남을 뿐이므로, 이 디렉토리를 읽어 시스템을 이해하려 하지 말 것.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 e2e 테스트로 동결되며, 구현 중 수정할 수 없다.
> 스펙 결함 발견 시: spec을 먼저 고치고 테스트를 재동결한다 (사유를 커밋 메시지에).

## 목표

프로덕션에서 질문을 보내면 답변이 오기까지 **2~6.5초** 동안 화면에 「지침 근거를 검색하는 중…」
한 문구만 선다. §8이 정의한 이벤트 중 그 구간에 경계를 놓는 것이 `retrieval.started` 하나뿐이라
FE가 관측할 수 있는 단계가 없기 때문이다.

그 구간은 실제로는 **embed → 검색 → 리랭크** 세 단계이고 (아래 실측), 근거 도착 뒤에도
**LLM TTFT 0.65~1.5초**의 창이 더 있다. 이 경계들을 이벤트로 내보내 화면이 진행을 말하게 한다.

## 실측 조사 (2026-09-06, prod cure.demo01.xyz — §45 어휘 프리필터 배포 후, 표본 6)

측정 방법: 브라우저에서 `fetch`로 SSE를 직접 열어 **chunk 단위와 프레임 단위 도착 시각을 함께**
기록하고, 같은 요청의 서버 구간을 `/api/v1/metrics` 히스토그램 증분으로 대조했다. 화면 문구로는
갈리지 않는 문제라 프레임을 직접 봤다.

### 대기 구간의 실제 분해 — 서버 구간 합이 관측 시각과 일치한다

| 표본 | embed | vector | keyword | rerank | **구간 합** | `retrieval.completed` 바이트 도착 |
|---|---:|---:|---:|---:|---:|---:|
| 콜드(첫 요청) | 2,575 | 623 | 2,048 | 1,887 | **6,510ms** | 6,705ms |
| 웜 | 903 | 291 | 321 | 1,025 | **2,249ms** | 2,403ms |
| 배치 4건 평균 | 236 | 298 | 360 | 1,410 | **2,006ms** | 1,522~2,994ms |

두 arm은 `Promise.all`이라 구간 합 = embed + max(vector, keyword) + rerank다. **합이 관측 시각과
150~200ms 안에서 맞는다**(차이는 요청 수립분). 즉 `retrieval.completed`는 코드가 놓인 자리
(`conversation-stream.service.ts:356` — 리랭크 직후·LLM 호출 이전)에서 **제때 발신되고 있다**.

**§45가 지형을 바꿨다.** 이 스텝을 연 FE 조사(2026-09-04)는 프리필터 배포 전이라 `keyword_search`가
3,684ms(14일 평균 n=63)로 지배적이었으나, 지금은 321~360ms다. **대기의 최대 구간은 이제 리랭크**
(평균 1,410ms · 최대 1,887ms)이고, embed와 합쳐 **86%**가 외부 API 호출 두 번이다.

### 왜 FE의 2단계 문구가 한 프레임도 서지 못하는가 — 원인은 발신 시점이 아니라 **프레임 크기**다

| 표본 | `retrieval.completed` 크기 | 바이트 도착 시작 | 프레임 **완결** | 갇힌 시간 | 첫 delta와 같은 chunk |
|---|---:|---:|---:|---:|:---:|
| 산조인탕 | ~30KB | 6,705ms | 7,640ms | 935ms | **예** |
| 만성요통 | 30,437B | 2,403ms | 3,053ms | 650ms | **예** |
| 불면 침치료 | 26,863B | 2,994ms | 3,738ms | 744ms | **예** |
| 편두통 전침 | 35,304B | 1,522ms | 3,036ms | 1,514ms | **예** |
| 갱년기 안면홍조 | 18,585B | 2,070ms | 2,858ms | 788ms | **예** |
| **기권(대조군)** | **55B** | **351ms** | **351ms** | **0** | — (즉시) |

evidence 5건을 실은 프레임은 **18~35KB**다. 바이트는 일찍 흐르기 시작하지만 **꼬리가 첫 delta의
write에 밀려서야 도착**한다 — 성공 경로 **5/5 전부** 두 이벤트가 같은 chunk였다. 갇힌 시간은
매번 그 요청의 LLM TTFT와 같다.

**대조군이 원인을 확정한다.** evidence 0건이면 프레임이 55B이고 즉시 완결된다. 그리고 앱·프록시는
용의자가 아니다 — nginx 1.31.5 + HTTP/2 + TLS를 로컬에 세워(prod와 같은 `proxy_buffering off`)
30KB 프레임 + 650ms 공백을 재현하니 **한 번에 완결됐다**(RTT 0). 크기와 실제 네트워크의
상호작용이므로 **우리가 통제할 수 있는 축은 프레임 크기뿐이다.**

### 이 실측이 반증한 것

이 스텝을 연 FE 조사는 「`retrieval.completed`가 검색 직후가 아니라 답변이 준비된 뒤에 발신된다」로
원인을 지목하고 「검색이 끝난 즉시 발신」을 작은 변경으로 제안했다. **둘 다 성립하지 않는다** —
발신은 이미 제때이고(위 표), evidence는 리랭크의 산출이라 더 앞당길 수도 없다. FE 관측 자체는
정확했고 결론만 갈렸다: 관측된 것은 발신 지연이 아니라 **프레임 꼬리의 도착 지연**이었다.

### 없는 관측 축

`llm_request_duration_seconds`(평균 1,730ms)는 스트림 **전체**라 첫 토큰까지를 못 가른다.
이번 조사의 TTFT 0.65 · 0.74 · 0.79 · 0.89 · 1.51초는 전부 **브라우저 관측으로만** 얻었다.

## 판단 근거 (2026-09-06 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 이벤트를 어떤 형태로 넣는가 | **단일 `retrieval.progress` + `stage` 필드다.** 단계가 늘거나 줄어도 이벤트 타입이 늘지 않고, FE는 stage→문구 사전 하나만 갖는다. 무엇보다 **리랭크가 꺼진 구성**(`RETRIEVAL_RERANK_ENABLED=false`, §29)에서 「오지 않는 이벤트 타입」이 생기지 않는다 — 타입으로 쪼개면 FE가 「안 오는 것이 정상인 타입」을 구성별로 알아야 한다 |
| 왜 진행 이벤트가 통하는가 | **작기 때문이다.** 대조군(55B)이 즉시 완결됐고 delta(97B)도 18~30ms 간격으로 계속 도착한다. 진행 이벤트는 **evidence를 싣지 않아** 100B 미만이므로 30KB 프레임이 겪는 꼬리 지연을 겪지 않는다. 이것이 「크기가 유일한 통제축」이라는 실측의 직접 귀결이다 |
| `answer.started`를 넣는가 | **넣는다 — 2단계 문구를 살리는 유일한 수단이다.** LLM 호출 직전에 나가는 작은 프레임이라 ⑴ 즉시 도착하고 ⑵ **앞선 `retrieval.completed`의 꼬리를 함께 밀어낸다**. 그래야 근거 배열과 「답변 작성 중」이 첫 delta보다 먼저 화면에 서고, 실측 TTFT 0.65~1.5초가 그대로 창이 된다. 지금은 그 창이 0ms다(5/5) |
| `retrieval.completed`를 쪼개거나 줄이는가 | **아니다.** evidence 배열은 FE가 근거 카드를 그리는 원천이고 §8이 그 자리를 계약했다. 크기를 줄이려면 청크 원문을 빼야 하는데 그건 근거 표시 기능 자체를 되돌리는 것이다. **꼬리를 미는 쪽**(`answer.started`)이 계약을 보존하면서 같은 결과를 낸다 |
| 리랭크가 꺼져 있으면 | **`reranked` stage를 보내지 않는다.** 일어나지 않은 단계를 보내면 화면이 없는 진행을 지어낸다. FE는 모르는·안 오는 stage를 무시하므로(아래) 구성 차이가 소비 코드에 새지 않는다 |
| 기권 경로에서도 보내는가 | **거기까지 도달한 단계만 보낸다.** 거리 게이트(①)로 기권하면 리랭커를 부르지 않으므로(`conversation-stream.service.ts:309`) `reranked`도 `answer.started`도 없다. 「보낸 진행은 실제로 일어난 일」이 이 스텝의 불변식이다 |
| `candidates`를 싣는가 | **`searched`에만 싣는다** — 후보 수는 그 단계의 산출이고, 화면이 「후보 N건에서 고르는 중」을 말할 수 있게 하는 유일한 값이다. 다른 stage에는 실을 것이 없어 넣지 않는다(빈 필드는 계약을 넓히기만 한다) |
| 배포 순서 | **BE 먼저여도 안전하다.** FE `streamReducer`는 `switch`의 default가 상태를 그대로 돌려주므로 모르는 `eventType`을 이미 무시한다. 계약은 **additive**다 — 기존 6개 이벤트의 필드가 하나도 바뀌지 않으므로 §8 복구 규약(`message.accepted` 기준점)도 그대로다 |
| TTFT 축을 추가하는가 | **추가한다.** 이 스펙이 여는 창의 크기가 곧 TTFT인데 그것을 재는 서버 축이 없어 이번 조사도 브라우저로만 확정했다. 창이 실제로 열리는지를 다음에도 브라우저로 재야 한다면 그 값은 관측되지 않는 것과 같다 |
| 계약에 스키마를 적는가 | **적는다.** 지금 `responses: {"201": {"description": ""}}`뿐이라 SSE 이벤트에 타입이 없고, FE는 `{ eventType: string; [key: string]: unknown }`로 받아 손으로 해석한다. 이벤트를 **늘리는** 이번이 그 부채를 갚을 자리다 — 단, 표현은 description 갱신 + §8 갱신까지이고 생성 스키마를 손으로 고치지는 않는다(§1 codegen 규율) |

**위험.** ⑴ `answer.started`가 꼬리를 미는 것은 **네트워크 계층의 성질에 기댄 결과**다 — 크기가
작아 즉시 나가는 것은 실측됐지만, 앞선 프레임의 꼬리가 언제 도착하는지는 계약이 아니다. 그래서
수용 기준은 **발신 순서**만 동결하고 도착 시각을 동결하지 않는다(e2e가 잴 수 없는 것을 단언하면
그 테스트는 거짓말이다). ⑵ 진행 이벤트가 늘면 스트림 프레임 수가 늘지만 4개 × ~80B로 무시할 수
있다. ⑶ 리랭크가 꺼진 구성에서 `searched`와 `retrieval.completed` 사이가 0ms에 가까워 화면이
한 번 깜빡일 수 있다 — 문구 전환의 최소 표시 시간은 FE 소유다(Out of scope).

## 범위 (진입점)

**엔드포인트 신규·삭제 없음. 기존 6개 SSE 이벤트의 페이로드 무변경 — additive하게 2종을 더한다.**

| 진입점 (BE) | 변경 |
|---|---|
| `conversation-stream.service.ts` | ⑴ embed·검색·리랭크 경계에서 `retrieval.progress` 발신 ⑵ `generateAnswer` 진입 직후·`llmGateway.stream` 호출 **직전**에 `answer.started` 발신 ⑶ 단계 경계를 알려면 `searchHybrid`/`search`가 embed와 검색을 갈라 보고해야 한다(아래) |
| `retrieval.service.ts` | 단계 완료 콜백을 받는다 — 지금 `recordRetrievalStage`로 **메트릭에만** 흘리는 경계를 호출자도 볼 수 있게 한다. 순위 식·정렬 키·정책 버전 문자열은 **불변**(§31·§45) |
| `llm-gateway.ts` | 첫 **delta**에서 TTFT 관측 (§40 기준과 같은 「첫 토큰」 정의 — verdict는 사용자에게 나가는 출력이 아니다) |
| `metrics.service.ts` | `llm_time_to_first_token_seconds{provider}` 히스토그램 신규 |
| `conversation.controller.ts` | `@ApiOperation` description에 새 이벤트 반영 (`openapi/`는 `pnpm codegen` 산출) |
| `docs/architecture.md` §8 | `ConversationStreamEventDto` 유니온에 2종 추가 + 단계 규약 |

| 진입점 (FE — cure-agent-fe) | 변경 |
|---|---|
| `src/features/ask-guideline/model/stream-state.model.ts` | `retrieval.progress`·`answer.started`를 reducer에 배선. `answer.started`는 `phase`를 **`generating`**(신규)으로 올린다 — `streaming`으로 올리면 본문이 없는데 본문 렌더로 넘어간다 |
| `src/features/ask-guideline/ui/chat-panel.tsx` | 대기 상자의 문구 축을 `evidence.length`에서 **단계**로 바꾼다. 경과 시간 표시(PR #107)는 그대로 유지 |
| `src/shared/i18n/messages.ts` | stage별 문구 ko/en. 기존 `retrievingEvidence`·`draftingAnswer`·`waitElapsed`는 유지 |

## Entity / 마이그레이션 변경분

- 없음 — 스트림 전송 계약과 관측 축만 바뀐다. 영속화 대상이 아니다.

## 추가 에러코드

없음 — 진행 이벤트는 실패 경로를 만들지 않는다. 발신 실패는 스트림 자체의 실패로 이미 드러난다.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

**진행 이벤트가 실제로 일어난 단계만 말한다**

1. 해피패스 스트림이 `retrieval.progress`를 `stage=embedded` → `searched` → `reranked` 순서로 발신한다 (BE e2e)
2. 세 진행 이벤트는 모두 `retrieval.started` **뒤**, `retrieval.completed` **앞**에 온다 (BE e2e)
3. `stage=searched`는 `candidates`에 검색이 반환한 후보 수를 싣는다 (BE e2e)
4. `embedded`·`reranked`에는 `candidates`가 **없다** (BE e2e — 빈 필드로 계약을 넓히지 않는다)
5. 리랭크가 꺼져 있으면(`RETRIEVAL_RERANK_ENABLED=false`) `stage=reranked`가 **오지 않는다** (BE e2e)
6. 리랭크가 꺼져 있어도 `embedded`·`searched`는 그대로 온다 (BE e2e)
7. 리랭커 호출이 실패해 순위 폴백한 경우에도 `reranked`가 온다 — 단계는 일어났고 결과만 폴백이다 (BE e2e — §29 폴백 규약)
8. 하이브리드가 꺼져 있어도(`RETRIEVAL_HYBRID_ENABLED=false`) `embedded`·`searched`가 온다 (BE e2e)

**답변 시작이 근거 도착과 첫 델타 사이에 선다**

9. `answer.started`가 `retrieval.completed` **뒤**, 첫 `answer.delta` **앞**에 발신된다 (BE e2e — 이 순서가 2단계 문구의 창이다)
10. `answer.started`는 evidence를 싣지 않는다 (BE e2e — 작아야 즉시 도착한다는 것이 이 스텝의 전제다)
11. 생성 게이트(④)가 발화해 기권한 경우에도 `answer.started`는 이미 발신돼 있다 — LLM을 실제로 불렀기 때문이다 (BE e2e — §40)

**기권 경로는 도달한 단계까지만 말한다**

12. 근거 0건 기권은 `answer.started`를 발신하지 않는다 (BE e2e — LLM을 부르지 않는다)
13. 거리 컷 기권(①)은 `stage=reranked`를 발신하지 않는다 — 리랭커를 부르지 않는다 (BE e2e — §28)
14. 점수 컷 기권(③)은 `reranked`까지 발신하고 `answer.started`는 발신하지 않는다 (BE e2e — §29)
15. 기권 경로의 `retrieval.completed`·`answer.abstained`는 §8 그대로다 (BE e2e — 회귀)

**기존 계약이 그대로다**

16. `message.accepted`·`retrieval.started`·`retrieval.completed`·`answer.delta`·`answer.completed`·`answer.abstained`·`error`의 **필드가 하나도 바뀌지 않는다** (BE e2e — additive 확인)
17. `answer.delta`의 `seq`는 여전히 0부터 연속이다 — 진행 이벤트가 그 사이에 끼어도 영향이 없다 (BE e2e)
18. 스트림 실패 시 `error` 이벤트와 메시지 `FAILED` 처리가 그대로다 (BE e2e — §8-6 회귀)
19. 클라이언트 abort → `CANCELLED` 정리가 그대로다 (BE e2e — §8-4 회귀)

**관측**

20. 첫 `answer.delta`가 나간 요청은 `llm_time_to_first_token_seconds{provider}`를 1회 관측한다 (BE e2e)
21. verdict만 받고 델타 없이 끝난 요청(생성 게이트 기권)은 TTFT를 **관측하지 않는다** (BE e2e — 「첫 토큰」의 정의가 §40과 같아야 한다)
22. `rag_retrieval_duration_seconds{stage=…}`·`rag_rerank_duration_seconds`가 계속 관측된다 (BE e2e — §27·§29 유지)

**화면이 단계를 말한다**

23. `retrieval.progress`를 받으면 대기 문구가 그 단계의 문구로 바뀐다 (FE 유닛)
24. `answer.started`를 받으면 `phase`가 `generating`이 되고 문구가 「근거 N건을 바탕으로 답변을 작성하는 중」으로 바뀐다 (FE 유닛)
25. `generating` 상태에서는 본문 영역을 렌더하지 않는다 — 아직 델타가 없다 (FE 유닛)
26. 첫 `answer.delta`에서 `phase`가 `streaming`으로 올라가고 본문 렌더로 넘어간다 (FE 유닛 — 회귀)
27. 모르는 `eventType`·모르는 `stage`를 받아도 상태가 바뀌지 않는다 (FE 유닛 — BE 선배포가 안전한 근거)
28. 경과 시간 표시(PR #107)가 단계 전환과 무관하게 이어진다 (FE 유닛 — 기다린 시간은 단계와 축이 다르다)
29. 진행 이벤트가 하나도 오지 않아도(구버전 BE) 오늘의 문구로 동작한다 (FE 유닛 — 되돌림 안전)
30. stage별 문구가 ko·en 양쪽에 있다 (FE 유닛 — §42·§44와 같은 이유)

fixture 규약: e2e는 **실 코퍼스도 실 프로바이더도 부르지 않는다.** 청크는 구조를 모방한 합성
텍스트를 적재하고(§13), LLM·리랭커·임베더는 결정적 fake를 쓴다. 기대값 원천은 **이 문서의 순서
규약**이지 구현의 상수가 아니다(§41·§42·§44·§45와 같은 이유). **이 문서의 시간 수치(2,249ms·
TTFT 0.65~1.5초 등)는 prod 네트워크와 외부 API의 성질이므로 e2e의 단언 대상이 아니다** — 동결하는
것은 **이벤트의 순서와 존재 조건**이다.

## Out of scope

- **대기 자체를 줄이는 것** — 이 스텝은 진행을 *말할* 뿐 빠르게 하지 않는다. 실측상 다음 표적은
  리랭크(1,410ms)와 embed(736ms)로 둘 다 외부 API 호출이고, §45가 `keyword_search`에 한 것과
  같은 별건의 조사가 필요하다.
- **`retrieval.completed` 프레임 크기 줄이기** — evidence 배열은 §8이 계약한 자리이고 근거 카드의
  원천이다. `answer.started`가 꼬리를 미는 것으로 충분함이 실측으로 확인됐다.
- **문구 전환의 최소 표시 시간** — 리랭크가 꺼진 구성에서 단계 사이가 0ms에 가까울 수 있다.
  깜빡임은 화면 소유이고 이 계약이 정할 것이 아니다.
- **잡 진행 스트림(§22)** — 별도 계약이고 이미 `run.stage`로 단계를 말한다.
- **SSE 이벤트의 생성 스키마화** — description과 §8은 갱신하지만 `openapi/`·`generated/`의 oneOf +
  discriminator 표현은 손으로 고치지 않는다(§1). 필요해지면 overlay로 별건으로 연다.
- **끊김 복구 계약의 변경** — 진행 이벤트는 상태를 만들지 않으므로 §8 복구 규약(재조회 기준점)이
  그대로다.
