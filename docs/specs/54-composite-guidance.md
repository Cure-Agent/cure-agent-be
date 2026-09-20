# 54. 복합 답변 참고안 — 라벨로 물은 환자 맞춤 답변도 검토 대상 참고안이 되고, 완결이 그것을 답변과 함께 세운다

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> 완료된 spec은 커밋 로그처럼 기록으로 남을 뿐이므로, 이 디렉토리를 읽어 시스템을 이해하려 하지 말 것.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 e2e 테스트로 동결되며, 구현 중 수정할 수 없다.
> 스펙 결함 발견 시: spec을 먼저 고치고 테스트를 재동결한다 (사유를 커밋 메시지에).

## 목표

에이전트 **복합 경로의 완료 답변이 환자 고정 대화와 같은 임상 참고안(`DRAFT`)과 의료인 검토(§5.6)를 갖는다.** 끝나면 일반
대화에서 「CASE-001에게 침 치료해도 돼?」의 답 아래에 참고안 카드가 뜨고, 그 자리에서 검토를 기록할 수 있으며, 대화를 다시
열어도 카드가 복원된다.

§51이 「BE 채팅의 몫」으로 남기고 §53이 「다음 스텝」으로 넘긴 것을 닫는다. 구조화기·검증기·조립기(§33)는 새로 만들지 않고
**BE 완결이 그대로 돌린다** — 에이전트는 오늘처럼 답변과 인용만 보낸다. PATIENT_GUIDANCE 대화의 에이전트화는 여전히 하지 않는다.

## 실측 조사 (2026-09-21, 3레포 코드 + 운영 DB·Prometheus + 구조화 입력 모사)

### 같은 종류의 답변이 한쪽만 검토 대상이다 (운영, 08-11~09-21)

| 확인 | 실측 |
|---|---|
| 에이전트 턴 | 12건 — GUIDELINE 2 · PATIENT 6 · COMPOSITE 2 · OTHER 2. `STREAMING`으로 남은 턴 0 |
| 복합 턴 | 완료 1건(147자 · 인용 2 · 6.6초 · `answerKind` 없음 · **참고안 없음**) · 생성 게이트 기권 1건. 둘 다 환자 스냅샷을 고정했다 |
| 환자 대화 참고안 | 36건 **전부 구조화 채택**(`guidance-v2` 25 · `guidance-v2-en` 11 · `deterministic-v1` 0). 검토 `DRAFT` 27 · `ACCEPTED` 7 · `MODIFIED` 2 |
| 구조화 소요 | `guidance_structure_duration_seconds` 09-05~09-21(리셋 세그먼트 합산) n=22 — 평균 **1.56초** · 1~2초 18 · 2~3초 4 · **최대 3초 미만**. 상한은 20초다(`structure-runner.ts:14`) |
| 환자 대화 완료 턴 소요 | n=36 — p50 9.3초 · p90 12.2초 · 최대 14.5초 (구조화 포함) |

### 완결이 참고안을 만들 재료는 이미 그 턴에 있다 (BE 코드)

| 확인 | 실측 |
|---|---|
| 구조화 입력 | 답변 텍스트 + **답변이 인용한 청크의 원문**·지침 제목·절 경로 + 스냅샷의 값 있는 필드 9종 + 언어(`guidance-structurer.port.ts:28-39` · `guidance-profile-fields.ts:32-40`) |
| 완결이 가진 것 | `content` · `citations[{marker, evidenceId}]`(`finish-agent-turn.request.dto.ts`) · 환자 도구가 고정한 `agent_turns.patient_snapshot_id` · 메시지의 `responseLang`. 빠진 것은 인용 청크의 지침 제목·절 경로뿐이다 — `findEvidenceChunks`가 id·원문만 읽는다(`conversation.repository.ts:368`) |
| 조립기 | 호출측 tx에 참여한다. 구조화가 null이거나 검증에서 전멸하면 인용 재배열(`deterministic-v1`), 인용 0건이면 「근거 요약」 1항목이다. summary·safetyAlerts·missingInformation은 어느 경로에서도 결정적이다(`clinical-guidance-composer.service.ts:61-89`) |
| 채팅의 순서 | 구조화는 영속화 tx **밖**(외부 호출이 커넥션을 상한만큼 붙잡지 않게), 조립은 답변 저장과 **같은 tx**(`conversation-stream.service.ts:867-925`) |
| 재조회 | 메시지 목록은 **`answerKind === 'CLINICAL_GUIDANCE'`인 메시지에만** `guidanceId`를 붙인다(`conversation.service.ts:188-195`). 복합 완결은 오늘 `answerKind`가 없다 |
| 참고안 조회·검토 | 스코프는 `clinicId`뿐이다 — 대화 타입을 보지 않는다(`clinical-guidance.service.ts:18-40`) |

### 이웃과의 접점

| 확인 | 실측 |
|---|---|
| 에이전트 대기 상한 | 완결 호출은 클라이언트 기본 **5초**다(`backend.py:25`) — 구조화 상한 20초보다 짧다. 실행 상한 150초(`turn.py:112`) · access 수명 900초 |
| FE 카드 | 스트림은 `state.guidance`, 재조회는 `message.guidanceId`로 그린다 — **대화 타입을 보지 않는다**(`chat-panel.tsx:357-383`). reducer는 `answer.completed`의 `guidance`를 경로 구분 없이 읽고(`stream-state.model.ts:288-294`), FE의 `answerKind` 사용처는 0이다 |
| 공개 계약 | 에이전트 경로는 문서 전용이고 이벤트는 description 문장으로만 적힌다 — `answer.completed`의 필드를 말하지 않는다(`openapi-document.factory.ts:42-57`, 채팅 경로도 같다). `ClinicalGuidanceResponseDto`는 이미 components에 있다 |
| 삭제 연쇄·파기 | 환자 삭제는 `agent_turns.patient_snapshot_id`로 그 대화를 찾고(`patient.repository.ts:136-153`), 대화 파기는 검토 → 참고안을 `message_id`로 먼저 지운다(`data-purge.repository.ts:248-284`, 클리닉 파기도 대화 → 환자 순 `:167-173`). 복합 참고안은 언제나 그 턴의 메시지에 달리고 그 턴 스냅샷의 환자를 가리킨다 — **새 축이 없다** |
| 환자 파기 보류 (#473) | `conversations.patient_id`만 본다(`data-purge.repository.ts:55-75`) — `patient_id`가 없는 에이전트 대화는 보류에 걸리지 않는다. 한 틱의 파기 대상 대화가 배치(200)를 넘어 그 대화가 밀리면 `agent_turns → 스냅샷` FK가 환자 파기 tx를 되돌린다. **§51부터 있던 결함이다** |
| 동결된 이웃 기준 | §51 기준 110·111은 **스냅샷을 고정하지 않은 턴**에 복합 완결을 보낸다(`agent-turn-accept-finish.e2e-spec.ts:486-521`). 기준 116(`answerKind` 없음)은 환자 경로 완결로 단언한다. §10 기준 5·§33 기준 5(일반 대화에 `guidance`·구조화 호출 없음)는 BE 채팅 스트림의 단언이다 |

### 구조화 입력 모사 — 에이전트 합성 결과 29건

에이전트 합성 평가의 복합 완료 29건(`results/synthesis/20260914T154213Z.generated.jsonl` — `agent-composite-v2`, 합성 환자 12명 +
운영 코퍼스 권고 청크, 40문항 중 기권 11)을 완결이 받을 모양(답변·인용 마커·근거 원문·기록)으로 바꿔 BE 구조화 러너와 검증기에 넣었다.

| 확인 | 실측 |
|---|---|
| 입력이 맞물리는가 | **29/29** — 인용 마커가 검증기의 「답변 인용」과, 기록 필드가 `patientFactors` 어휘와 맞물린다(인용 1~4건 · 채택 평균 2.2항목). **구조화기는 가짜였다** |
| 실모델 채택률 | **재지 못했다** — OpenAI 크레딧 소진(429 `credit_balance_exhausted`). 환자 대화의 36/36은 BE가 쓴 답변(`qa-v5`)의 수치이고, `agent-composite-v2`가 쓴 답변에서 같은지는 모른다 |

## 판단 근거 (2026-09-21 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 복합 답변의 참고안 | **만든다 — 복합 경로의 완료 답변만.** 환자 기록과 지침 근거를 함께 딛은 조언이 환자 대화에서는 검토 대상(§5.6)이고 라벨로 물으면 검토 없이 나가는 비대칭을 없앤다. §51이 이를 미룬 것은 에이전트의 소비자가 없던 때였다(§52로 일반 대화 전부가 에이전트를 부른다). **환자 경로는 만들지 않는다** — 기록 조회라 근거 다리가 없다(§33 「두 다리」). 기권·실패·끊김에도 만들지 않는다(채팅과 같다, §40) |
| 어디서 구조화하나 | **BE 완결 안에서 — §33의 구조화기·검증기·조립기를 그대로 쓴다.** 프롬프트·검증 규칙·킬스위치·폴백이 한 벌로 남고, 참고안이 답변과 **같은 tx**에 선다(채팅이 「부분 커밋으로 답변만 남는 상태」를 막는 방식 그대로). 구조화 입력의 원문·프로필은 에이전트가 싣지 않고 BE가 인용 id와 턴 스냅샷에서 꺼낸다(§51이 진단명을 BE가 꺼내게 한 것과 같은 이유). **기각**: 에이전트가 구조화(프롬프트·스키마가 Python에 한 벌 더 생기고, 참고안은 판단이 아니라 저장물이다 — §51 「Python은 판단만」) · 완결 뒤 별도 도구(닫힌 턴을 다시 여는 API가 필요하고 답변만 남는 상태가 생긴다) |
| 만드는 조건 | **`COMPLETED` · `route=COMPOSITE` · 턴에 고정된 스냅샷, 셋 다.** 스냅샷 없는 복합 완결은 **422가 아니라 참고안 없이 완결한다** — 「누구의 기록인가」 없이는 참고안이 성립하지 않고, 422로 막으면 §51 기준 110·111을 재동결해야 한다. 오늘의 에이전트는 환자 도구 없이 복합 완결에 닿지 않는다(§51 기준 37) |
| 실패·상한·킬스위치 | **채팅과 같다 — 결정적 조립으로 폴백하고 완결은 선다.** 완결은 구조화 때문에 실패하지 않는다. 구조화는 tx 밖에서, 닫힌 턴 판정·본문 검증·인용 존재 검증 **뒤에** 돈다(비용보다 검증이 먼저다) |
| `answerKind` | **참고안을 만든 완결은 `CLINICAL_GUIDANCE`다.** 재조회의 `guidanceId` 부착이 이 값을 본다(실측). 기존 enum 값이라 공개 계약이 늘지 않고, §51 기준 116은 환자 경로로 단언하므로 그대로 선다. **기각**: `answerKind` 없이 두고 목록 조회가 전 메시지의 참고안을 찾게 한다(일반 대화 전 페이지에 조회가 하나 는다) |
| 완결 응답 | **`data`는 `MessageResponseDto`에 선택 필드 `guidance`가 더해진 모양이다** — 참고안을 만든 완결에만 키가 있다. 에이전트가 이를 `answer.completed{message, guidance}`로 갈라 보내 채팅 스트림과 같은 모양을 만든다(§8). 메시지에 `guidanceId`를 싣지 않는 것도 채팅과 같다. **기각**: 에이전트가 `GET /clinical-guidance/{id}`로 다시 읽는다(턴이 닫힌 뒤의 실패 경로가 하나 더 생기고, 실패하면 카드가 새로고침 전까지 없다) · `{message, guidance}` 봉투(§51 완결 기준 전부 재동결) |
| 완결 대기 상한 | **에이전트의 완결 호출만 connect 5초 · read 30초**(BE 구조화 상한 20초 + 저장). 환자 도구·수락은 5초 그대로다. **실행 상한 150초는 그대로 둔다** — 구조화 실측이 3초 미만이라, 상한을 올려 선검사 401(§51, 요청의 약 5%)을 늘릴 이유가 없다 |
| 공개 계약 | **OpenAPI diff 0.** 에이전트 경로의 description은 이벤트 필드를 말하지 않으므로 그대로 참이다. contract-sync PR이 생기지 않는다 |
| FE | **코드는 바뀌지 않는다 — 가드 3기준만 동결한다.** 카드가 대화 타입이 아니라 데이터 유무로 뜬다는 오늘의 성질을 못 박아, 누가 카드를 환자 대화로 좁히면 테스트가 막는다. 대가는 FE 레포의 테스트뿐인 `/implement 54` 한 사이클이다 |
| 실모델 모사 | **하지 않고 간다.** 동결하는 것은 계약이지 채택률이 아니고, 채택이 낮아도 결과는 결정적 카드(인용 재배열)라 정합성은 그대로다. 입력이 맞물리는 것은 쟀다(29/29). 채택률은 배포 후 `composer_version`으로 본다(위험 ⑴) |
| 환자 파기 보류의 사각 | **별도 [BUG]로 간다.** 이 스텝은 같은 축에 FK 보유 행을 늘릴 뿐 새 종류의 실패를 만들지 않는다(환자 파기는 지금도 `agent_turns → 스냅샷`에서 같은 문장으로 실패한다). 기능 스펙과 결함 수정의 원인을 섞지 않는다 |
| 메트릭 | **그대로 쓴다**(`guidance_compose_total` · `guidance_structure_duration_seconds`). 경로별 채택률은 DB(`clinical_guidances.composer_version` × `agent_turns`)가 말한다 — 카운터는 재시작에 리셋된다 |

**위험.**
- ⑴ **에이전트가 쓴 답변에서 구조화가 덜 채택될 수 있다**(미측정). 그러면 복합 카드가 인용 재배열로 나온다 — 질의 문제이지 정합성의 문제가 아니다.
- ⑵ **완결이 느려진다.** 마지막 델타와 `answer.completed` 사이가 구조화만큼 벌어진다(실측 1.6초 · 상한 20초) — 환자 대화가 오늘 겪는 것과 같다. 그 사이 끊으면 `CANCELLED` 완결이 이길 수 있고(종결은 조건부 UPDATE, §51) 구조화 비용은 버려진다.
- ⑶ **실행 상한의 여유가 준다.** 합성이 130초 가까이 끌린 턴은 완결이 상한에 잘려 `FAILED`가 된다(운영 복합 턴 6.6초).
- ⑷ **복합 완료 1건당 LLM 호출이 1회 는다.**
- ⑸ **배포 순서를 어기면 답이 다 흐른 턴이 `FAILED`로 닫힌다** — 옛 에이전트의 5초가 구조화를 끊고 `FAILED` 완결이 먼저 선다. 실측 분포(3초 미만)에서는 드물지만 상한은 20초다.
- ⑹ **일반 대화는 클리닉 공유 자산이다**(§5.7) — 구성원 누구나 그 참고안을 검토할 수 있다. 환자 대화도 같다.
- ⑺ **환자 파기 보류의 사각**(실측) — 기존 결함이고 별도 [BUG]다. 닿으려면 한 틱의 파기 대상 대화가 200건을 넘어야 한다.

## 범위 (엔드포인트)

**공개 BE 엔드포인트 신규·변경 없음 — OpenAPI diff 0.** 바뀌는 것은 내부 완결의 응답과 에이전트 스트림의 복합 종결 이벤트다.

| API (BE 내부 — 에이전트만 부른다) | Request | Response |
|---|---|---|
| `POST /api/v1/internal/agent/turns/{assistantMessageId}/finish` | 그대로(§51) | 200 `MessageResponseDto` + `guidance?: ClinicalGuidanceResponseDto` — 참고안을 만든 완결에만 키가 있다 |

```
복합  … → answer.delta*(판정 뒤) → [finish: 검증 → 구조화(tx 밖) → 종결·인용·run·참고안(한 tx)]
      → answer.completed{message, guidance} | answer.abstained
```

| 진입점 (BE) | 변경 |
|---|---|
| `src/domain/agent-turn/service/agent-turn.service.ts` | 완결 — 조건이 서면 인용 청크의 원문·지침 제목·절 경로와 턴 스냅샷의 프로필·턴 언어로 구조화(tx 밖)한 뒤, 종결·인용·run과 **같은 tx에서** 조립하고 `answerKind`를 찍는다. 응답에 `guidance` |
| `src/domain/agent-turn/dto/response/` (신규 DTO) · `agent-turn-internal.controller.ts` | 완결 응답 — 메시지 + `guidance?` |
| `src/domain/conversation/service/conversation-stream.service.ts` | 구조화 실행과 결말 계측(`structureGuidance` · `recordGuidanceCompose`)을 채팅과 완결이 **같은 함수로** 쓴다 — 입력을 「검색 행」에서 「마커·원문·제목·경로」로 일반화한다 |
| `src/domain/conversation/repository/conversation.repository.ts` | 인용 청크를 id로 읽을 때 지침 제목·절 경로까지 읽는다 |
| `src/domain/agent-turn/agent-turn.module.ts` | 구조화기·조립기·스냅샷 서비스 주입 |
| `docs/architecture.md` | §5.6 「복합 답변도 참고안」 · §5.7 에이전트 턴 문단의 「참고안 검토 흐름은 BE 채팅의 몫」 문장 · §8 에이전트 스트림 복합 흐름 · §9 AgentTurn·MessageEntity 행(`answerKind`) |

| 진입점 (AGENT — medical-agentic-rag) | 변경 |
|---|---|
| `app/service/backend.py` | 완결 호출의 대기 상한 — connect 5초 · read 30초. 다른 JSON 호출은 5초 그대로 |
| `app/service/turn.py` | 완결 응답의 `guidance`를 떼어 `answer.completed{message, guidance}`로 보낸다 · 모듈 docstring의 이벤트 흐름 |
| `docs/architecture.md` | 복합 종결 이벤트와 완결 대기 상한 |

| 진입점 (FE — cure-agent-fe) | 변경 |
|---|---|
| `src/features/ask-guideline/ui/` 테스트 | 가드 테스트만 — 코드는 바뀌지 않는다 |

**배포 순서는 AGENT가 먼저다** — 새 에이전트는 옛 BE와 그대로 돈다(`guidance`가 없으면 오늘과 같다). 반대 순서는 위험 ⑸다.
FE는 순서와 무관하다.

**배포 후 확인 (동결 밖)**
- ① 운영 일반 대화에 복합 질문 1건 — 답 아래 카드가 뜨고, `clinical_guidances` 1행이 그 메시지와 그 턴의 스냅샷을 가리킨다.
- ② 그 카드에서 검토를 기록하면 `review_status`가 바뀐다. ③ 새로고침해도 카드가 복원된다.
- ④ 환자 경로 질문 1건 — 카드가 없고 `answerKind`가 없다.
- ⑤ 복합 질문 5건쯤의 `composer_version` 분포를 본다(위험 ⑴) — 크레딧 충전이 먼저다.

## Entity / 마이그레이션 변경분

- 없음 — 기존 `clinical_guidances`와 `messages.answer_kind`를 쓴다. 삭제 연쇄·파기 순서도 그대로다(실측).

## 추가 에러코드

- 없음 — 공통 코드로 충분.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

**BE — 복합 완결이 참고안을 세운다** (환자 도구로 스냅샷을 고정한 턴 · 받은 입력을 기록하는 가짜 구조화기)

1. `COMPOSITE`·`COMPLETED` 완결 응답 `data`에 `guidance`가 있다 (BE e2e)
2. 그 `guidance.reviewStatus`가 `DRAFT`다 (BE e2e)
3. 그 메시지를 가리키는 `clinical_guidances` 행이 1건 생긴다 (BE e2e)
4. 그 행의 `patient_snapshot_id`가 `agent_turns.patient_snapshot_id`와 같다 (BE e2e — 검색·합성·참고안이 같은 기록을 딛는다, §53 기준 13과 같은 이유)
5. 그 행의 `patient_id`가 그 스냅샷의 환자다 (BE e2e)
6. 구조화기가 받은 `answerText`가 완결 `content`다 (BE e2e)
7. 구조화기가 받은 근거의 마커가 완결 `citations`의 마커와 같다 (BE e2e)
8. 그 근거의 `content`가 그 청크의 원문 전체다 (BE e2e — 발췌가 아니다, §33)
9. 그 근거에 지침 제목과 절 경로가 있다 — 각각 (BE e2e)
10. 구조화기가 받은 `profileFields`가 턴 스냅샷의 값 있는 필드다 (BE e2e — 진단명 값으로 단언한다)
11. `responseLang=en`인 턴이면 구조화기가 받은 `lang`이 `en`이다 (BE e2e — §44)
12. 구조화 항목이 검증을 통과하면 `composer_version`이 구조화 프롬프트 버전이다 (BE e2e)
13. 알레르기가 있는 스냅샷이면 `guidance.safetyAlerts`에 그 알레르기가 있다 (BE e2e — 안전 규칙은 LLM 출력이 대체하지 못한다, §33 기준 6)
14. 완결 응답 `data`의 `answerKind`가 `CLINICAL_GUIDANCE`다 (BE e2e)
15. 메시지 목록에서 그 메시지에 `guidanceId`가 실린다 (BE e2e — 재조회가 카드를 복원한다)
16. `GET /clinical-guidance/{id}`가 그 참고안을 돌려준다 (BE e2e)
17. `POST /clinical-guidance/{id}/reviews`가 그 참고안의 검토를 기록한다 (BE e2e — 일반 대화에 달린 참고안도 같은 검토를 탄다)

**BE — 구조화가 안 돼도 완결은 선다**

18. 구조화기가 예외를 던져도 완결이 200이다 (BE e2e)
19. 그때 참고안의 `composer_version`이 `deterministic-v1`이다 (BE e2e — §33 기준 3)
20. 구조화 항목이 전부 검증에서 떨어지면 `composer_version`이 `deterministic-v1`이다 (BE e2e — 인용에 없는 마커를 돌려주는 가짜)
21. 킬스위치(`disabled` 표식)면 구조화기를 부르지 않는다 (BE e2e — §33 기준 8)
22. 그때도 참고안이 `deterministic-v1`로 생긴다 (BE e2e)
23. 인용이 0건인 복합 완결이면 구조화기를 부르지 않는다 (BE e2e — 근거 다리가 없다)
24. 그때 참고안의 검토 항목이 1건이다 (BE e2e — §7 considerations ≥ 1)

**BE — 참고안은 완결과 함께 서거나 함께 없다**

25. 닫힌 턴에 온 복합 완결은 구조화기를 부르지 않는다 (BE e2e — 닫힌 턴 판정이 비용보다 먼저다, §51 기준 114)
26. 존재하지 않는 근거를 인용한 복합 완결(422)은 구조화기를 부르지 않는다 (BE e2e — §51 기준 111)
27. 그때 `clinical_guidances` 행이 없다 (BE e2e)
28. 구조화가 도는 동안 도착한 `CANCELLED` 완결이 턴을 닫으면 앞선 복합 완결은 409 `AGENT_TURN_CLOSED`다 (BE e2e — 가짜 구조화기를 멈춰 둔 채 단언한다. 종결은 조건부 UPDATE다)
29. 그때 참고안과 인용이 없다 — 각각 (BE e2e — 답변 없는 참고안을 남기지 않는다)

**BE — 참고안을 만들지 않는 완결**

30. 스냅샷을 고정하지 않은 턴의 복합 완결 응답에 `guidance` 키가 없다 (BE e2e — §51 기준 110의 모양)
31. 그때 `answerKind` 키가 없다 (BE e2e)
32. `PATIENT`·`COMPLETED` 완결은 스냅샷이 있어도 `guidance` 키가 없다 (BE e2e — 기록 조회에는 근거 다리가 없다)
33. 그때 구조화기를 부르지 않는다 (BE e2e)
34. `COMPOSITE`·`ABSTAINED` 완결은 참고안을 만들지 않는다 (BE e2e — 생성 게이트 기권에 참고안이 없는 채팅과 같다, §40)
35. `COMPOSITE`의 `FAILED`·`CANCELLED` 완결은 구조화기를 부르지 않는다 — 각각 (BE e2e)

**BE — 공개 계약과 파기는 그대로다**

36. 커밋된 OpenAPI가 바뀌지 않는다 (BE contract)
37. 환자를 삭제하고 유예가 지나면 파기가 **검토가 기록된** 복합 참고안의 대화·스냅샷·환자를 오류 없이 지운다 (BE e2e — 검토 → 참고안 → `agent_turns` → 메시지 → 스냅샷 순, §51 기준 120과 같은 이유)
38. 클리닉 파기가 복합 참고안이 있는 클리닉을 오류 없이 지운다 (BE e2e — §53 기준 24와 같은 이유)

**AGENT — 완결을 기다리고, 참고안을 그대로 흘린다**

39. 완결 호출이 read 상한 30초로 나간다 (AGENT 유닛 — fake 전송이 받은 요청의 timeout 확장값. BE 구조화 상한 20초보다 길다)
40. 완결 호출의 connect 상한은 5초다 (AGENT 유닛 — BE 순단을 오래 끌지 않는다, §49)
41. 환자 도구 호출의 read 상한은 5초 그대로다 (AGENT 유닛 — 회귀)
42. 완결 응답에 `guidance`가 있으면 `answer.completed`가 그것을 `guidance`로 싣는다 (AGENT 유닛)
43. 그때 `answer.completed.message`에는 `guidance` 키가 없다 (AGENT 유닛 — 채팅 스트림과 같은 모양, §8)
44. 완결 응답에 `guidance`가 없으면 `answer.completed`에 `guidance` 키가 없다 (AGENT 유닛 — 환자 경로와 옛 BE. §10 기준 5와 같은 모양)
45. 완결이 하트비트 주기보다 오래 걸리면 그동안 `: ping`이 나간다 (AGENT 유닛 — 주기는 주입한다, §51 기준 12)
46. 완결을 기다리는 동안 클라이언트가 끊으면 `CANCELLED` 완결을 보낸다 (AGENT 유닛 — §51 기준 56. 기다림이 길어졌다)
47. 추적을 켠 복합 요청의 페이로드에 완결 응답의 참고안 값이 없다 (AGENT 유닛 — 가드. 참고안에는 기록에서 온 알레르기명이 있고, 오늘은 완결 응답이 어떤 추적 실행에도 들어가지 않는다. §51 기준 62와 같은 방법)

**FE — 일반 대화의 복합 답변에도 카드가 선다** (코드는 바뀌지 않는다 — 가드)

48. GUIDELINE_QA 대화에서 에이전트 경로의 `answer.completed`에 `guidance`가 오면 참고안 카드가 뜬다 (FE 유닛)
49. 그 카드의 검토 기록이 `POST /api/v1/clinical-guidance/{guidanceId}/reviews`로 간다 (FE 유닛)
50. GUIDELINE_QA 대화를 다시 열었을 때 `guidanceId`가 있는 메시지 아래에 카드가 복원된다 (FE 유닛)

fixture 규약:
- **BE e2e는 §13대로 Testcontainers에 fake LLM·임베딩·리랭커·번역기를 쓰고, 구조화기는 `GUIDANCE_STRUCTURER`를 덮어쓴 가짜다**(§33·§44 스위트와 같은 방식) — 받은 입력을 기록하고, 예외·무효 항목·`disabled` 표식·**멈춤**(기준 28)을 시나리오마다 고른다. 스냅샷은 환자 도구를 실제로 불러 고정한다.
- **환자 기록·답변·근거는 구조를 모방한 합성 텍스트다** — 데모 환자 원문과 운영 질문을 쓰지 않는다. 진단명·알레르기명은 `합성진단-<ulid>`처럼 코퍼스에 없는 값이다(§53과 같은 방식).
- **AGENT 유닛은 실제 BE·LLM·LangSmith를 부르지 않는다**(§51 규약 그대로) — fake 전송이 완결 응답에 `guidance`를 싣거나 뺀다. 상한은 실제로 기다리지 않고 요청의 timeout 확장값으로 단언한다.
- **FE 유닛은 §52의 방식(`sendMessageStream` mock + `onEvent` 이벤트 주입)** 이고 이벤트 순서는 §8 「에이전트 스트림」의 복합 흐름이다. 기준 49는 `fetch`를 가짜로 둔다.
- **회귀 가드**: 환자 대화의 참고안 스위트(§10·§33·§40·§44·§53)와 에이전트 완결 스위트(§51 기준 106~116)의 단언을 바꾸지 않는다. 구조화 상한 20초의 폴백은 §33 기준 4의 러너 유닛이 이미 지킨다 — 완결은 그 러너를 쓴다.
- **이 문서의 수치는 단언 대상이 아니다** — 구조화 소요·채택률·턴 소요는 환경의 성질이다. 동결하는 것은 참고안을 만드는 조건·입력의 출처·같은 tx·폴백·응답 모양·대기 상한·화면의 성질이다.

## Out of scope

- **환자 경로의 참고안** — 기록 조회에는 근거 다리가 없다. · **PATIENT_GUIDANCE 대화의 에이전트화**(§51).
- **복합 답변의 참고안 평가** — `eval:guidance`는 BE가 쓴 답변만 잰다. 운영 표본과 `composer_version` 분포를 본 뒤 판단한다(위험 ⑴).
- **구조화 진행의 화면 표시** — 마지막 델타 뒤의 기다림에 문구를 주려면 `agent.progress`에 stage를 더하면 된다(§46 — 모르는 stage는 무시된다). 실측 1.6초라 하지 않는다.
- **실행 상한·선검사 기준의 재조정** · **완결의 클라이언트 끊김 감지**(에이전트가 끊어도 BE는 구조화를 끝까지 돈다).
- **환자 파기 보류가 에이전트 대화를 보게 하는 것** — 별도 [BUG](위험 ⑺).
- **경로별 구조화 메트릭 라벨** · **답변 배지·경로 필드**(§52 유보 그대로).
- **에이전트 pydantic 모델과 BE DTO의 기계적 동기화**(§52 유보 그대로) — 완결 응답의 `guidance`도 주석과 테스트가 지킨다.
