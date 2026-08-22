# 40. 답변가능성 게이트 — 생성 단계에서 근거 부족을 구조화 신호로 판정

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 테스트로 동결되며, 구현 중 수정할 수 없다.

## 목표

§29 점수 게이트는 「이 근거가 질문과 **관련** 있는가」를 재는데, 기권이 답해야 하는 질문은 「이 근거로
**답할 수 있는가**」다. 둘은 갈린다 — 군발두통 질문에 편두통 청크가 top1 관련도 10.0/10을 받았다
(리랭커는 제 일을 한 것이다). 답변가능성은 근거 전문을 보고 답을 써 보는 쪽만 판단할 수 있고, 지금
요청 경로에는 그 층이 없다(groundedness judge는 `domain/evaluation`에만 있다).

**판단은 이미 내려지고 있다.** 프롬프트 규칙 3이 「근거가 부족하면 먼저 밝힌다」를 지시하고 answerer는
그대로 따르는데, 산문이라 시스템이 읽지 못한다 — kind는 answer, `rag_abstains_total`은 안 오르고,
FE는 정상 답변으로 표시한다. 이 스텝은 판단을 새로 만들지 않는다. **이미 내려지고 버려지는 판단을
기계가 읽을 수 있는 신호로 승격**해 기존 기권 경로(`answer.abstained` + `ABSTAINED` +
`rag_abstains_total`)로 보낸다. 게이트는 4단이 된다 — ① 거리(§28) ② 리랭크 ③ 점수(§29) **④ 생성**.

## 실측 조사 (2026-08-23, 프로덕션 DB + `/metrics` + 코드)

| 확인 항목 | 실측 |
|---|---|
| 운영 검색 정책 | `hybrid-rrf60-top30x2-rerank-gpt-5.4-mini-cut0.48-score9-v4` — 하이브리드·리랭크 ON, 거리 컷 0.48, **점수 컷 9** (GenerationRun 21건 중 15건이 이 정책) |
| 등록 LLM 프로바이더 | **openai 단독** — `ANTHROPIC_API_KEY` 미설정(.env.prod 명시). `llm_requests_total`에 openai 계열만 있다 |
| ASSISTANT 메시지 | **63건** — COMPLETED 21 · **ABSTAINED 35** · FAILED 6 · STREAMING 1 |
| ABSTAINED의 GenerationRun | **0건** — 오늘 `ABSTAINED`는 「LLM을 부르지 않았다」와 동의어다 |
| `rag_abstains_total` | 프로메테우스 60일 조회에 **시계열이 없다** — 인메모리 카운터라 앱 재시작(2주 전)에 리셋됐고, 이후 6스트림이 전부 answered다. **기권 관측은 DB가 유일한 durable 축이다** |
| 스냅샷 vs 참고안 | `patient_profile_snapshots` 14 · `clinical_guidances` 13 — **스냅샷만 남고 참고안이 없는 상태가 이미 존재한다**(FAILED 1건) |
| **COMPLETED 21건 중 산문 거부** | **3건**. 인용 0건인 COMPLETED는 2건이고 둘 다 거부지만, **거부 3건 중 1건은 인용이 5건**이라 인용 수는 게이트 대용이 못 된다 |

거부 어구가 걸린 5건을 원문으로 분류했다. 이 표가 게이트의 참·거짓 발화를 모두 담고 있다:

| 질문 | 인용 | 실제 성격 | 게이트가 발화해야 하는가 |
|---|---|---|---|
| 급성 충수염 수술 전후 한의치료 | 0 | 「직접적인 내용이 없어 근거가 부족」 — 순수 거부. 제시된 근거는 슬관절·회전근개·요추 수술이었다 | **예**. §29가 「거리 컷이 놓치는 어휘 중첩형」의 예로 든 바로 그 충수염이 **두 게이트를 모두 통과**했다 |
| 부정출혈 치료법 (PATIENT_GUIDANCE) | 0 | 5개 근거가 각각 난임·안면신경마비·대상포진임을 열거하며 거부 | **예** |
| 만성 아토피 치료법 | **5** | 만성 피로증후군 지침이 왔다고 거부한 **뒤 귀비탕·십전대보탕·전침을 [1]~[5]로 인용해 나열** | **예**. 판정 문서의 「거부 후 덧붙이기」가 프로덕션에서 재현됐고, **무관 인용 5건이 영속화**됐다 |
| 골다공증 치료법 (PATIENT_GUIDANCE) | 5 | 한의치료는 완전히 답하고 **표준치료 축만** 근거 부족이라 밝힘 | **아니오** — 발화하면 과잉 기권. 아래 위험 ②의 프로덕션 실례다 |
| 만성 요통 침 치료 | 1 | 근거의 **불확실성**을 보고한 정상 답변(「효과없음을 포함」) | **아니오** |

오프라인 실측은 `docs/rag-eval/2026-08-23-answerability-gate-verdict.md`(별도 실험 레포, 36문항)에
있다. **프로덕션 평가셋이 아니고 지표 정의도 달라 185/44 리포트와 직접 비교 금지.** 운영 구성
(리랭크·컷 9)에서 `kind` 수준 기권 11/12 → **12/12**(두 번 다), 실질 기권은 전후 모두 12/12 —
answerer가 이미 판단하고 있었다는 증거다. 리랭커를 끄는 모드에서는 이 게이트가 12건 중 **7건**을 잡아,
`RETRIEVAL_RERANK_ENABLED=false` 롤백 상태의 안전망이 된다.

## 판단 근거 (2026-08-23 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 포트 계약 | **판별 유니온 yield.** `onUsage` 식 선택 콜백은 fake가 미호출해도 타입이 통과해 **e2e가 계약을 못 지킨다**(§3 「fake 치환 없이는 동결이 성립하지 않는다」를 타입이 지켜야 한다). 유니온이면 verdict가 delta보다 먼저라는 순서가 한 채널에 실리고, 게이트웨이의 「첫 토큰 이후 폴백 금지」를 **delta 기준으로** 유지해 verdict만 받고 죽은 시도는 여전히 폴백된다 |
| 스트리밍 분기 | **flag-first 스키마 + 증분 파싱.** 스키마에서 `insufficient_evidence`를 `answer`보다 먼저 선언하면(structured outputs는 스키마 순서로 생성한다) 프로바이더가 answer 첫 글자 전에 플래그를 안다. **전체 버퍼링을 하지 않으므로 TTFT는 오늘과 같다** — §29가 리랭크 +1초(p50 0.96s)를 이미 얹은 위에 답변 생성 전체를 더할 수 없다 |
| 기권 사유 | **신규 `insufficient_evidence` + 신규 문구.** §29가 사유를 통합한 둘(거리·점수)은 **같은 검색 단계**였고 사용자에게 「관련 근거를 못 찾았다」는 실제로 같은 사실이었다. 생성 게이트는 **근거를 찾은 뒤 그것으로 못 답한다**는 다른 사실이고 재질의 방향도 다르다 — §28 기준 5의 원칙(「사유가 다르면 다르게 읽혀야 재질의를 유도한다」)이 그대로 적용된다. 메트릭 분리도 이 사유가 그대로 해결한다 |
| `missing_aspects` 노출 | **SSE 무변경 — 내부에만 둔다.** FE 표시 변경이 out of scope인데 계약에 넣으면 렌더 여부를 이 스펙 밖에서 결정하게 된다. `answer.abstained`에는 이미 `missingInformation[]`이 있고 그 어휘는 §7이 **환자 프로필 필드명**으로 못 박아 참고안 DTO가 같은 뜻으로 쓴다 — 재사용하면 한 이름이 두 뜻을 갖는다 |
| 빈 `missing_aspects` | **기권시키되 원인을 나눠 센다**(`cause="model_verdict"` vs `"empty_aspects"`). 재호출·무효화를 지금 고르지 않는 이유는 **원인이 아직 구분되지 않았기 때문**이다 — 모델 판정인지 빈 응답인지 모르는 채 처방을 넣는 것은 §12 「측정 후 도입」을 거스른다. 구분 장치를 넣는 것이 이 스텝이고, 처방은 분포가 드러난 뒤다. 사용자 체감은 나빠지지 않는다 — 그 질문은 **오늘도 산문 거부를 받고 있다** |
| GenerationRun 기록 | **기록한다.** 「ABSTAINED ⇒ run 0건」 등식이 참이었던 이유는 「LLM을 안 불렀으니 기록할 게 없다」였는데, 생성 게이트는 **부르고 토큰을 쓴다**. 프롬프트·정책 버전·프로바이더·지연이 전부 실재하고, 과잉 기권을 사후에 문항 단위로 조사하려면 「어느 프롬프트·어느 검색 정책에서 발화했나」가 있어야 한다. 덤으로 `ABSTAINED + run 있음 = 생성 게이트` / `run 없음 = 검색 게이트`라는 자기서술적 불변식이 공짜로 생긴다 |
| 리랭크 점수 컷 | **9 그대로 둔다.** 실험은 컷 3.5에서 돌았지만 그 표본은 3~8 구간 관측이 1건뿐이라 애초에 컷을 판단할 표본이 아니다. 근거는 기존 운영 데이터다 — `2026-08-02-rerank-cut9-overabstain.md`의 히스토그램에서 3~8 구간이 **abstain 16건 대 answerable 3건**이다. 하향으로 회수할 것은 과잉 기권 3문항(0.016)뿐인데 대가는 abstain 16건의 검색 게이트 통과이고, 컷 8로만 내려도 2건 회수에 5건 누출이다 |
| `retrieval.completed` | **이미 나간 대로 둔다.** 생성 게이트는 근거를 보낸 뒤에 발화하므로 되부를 수 없고, 되부를 이유도 없다 — 근거를 보여준 뒤 「이 근거로는 답할 수 없다」고 말하는 것은 §29 검색 게이트가 **빈 evidence**를 싣는 것과 다른 사실이라 다르게 보이는 것이 옳다. 영속 기록은 동일하다(인용 0건) |

## 위험 — 과잉 기권 (이 설계의 주 리스크)

컷 9에서 두 번 돌려 answerable 24문항 중 **1건·2건**이 잘못 기권했다(컷 3.5에서는 0건). 매번 다른
문항이었고 전부 다른 실행에서는 정상 답변했으므로 변동 범위지만, 기전은 셋이다: ① 비교 질문에 「둘을
직접 대조한 문장」을 요구(각 축 근거로 합성 가능한데도) ② 다면 질문에서 한 축의 근거가 없다고 전체
기권(부분 답변으로 충분한데도 — **위 골다공증 답변이 프로덕션 실례**다) ③ 이유를 못 대면서 기권.

①·②를 겨냥한 합성 규칙을 프롬프트에 넣지만 **효과가 있다고 주장하지 않는다** — 재측정에서 목표
문항은 고쳐졌으나 총량이 1건 → 2건으로 움직였고, 24문항에서 1~2건은 변동 폭 안이다. 근거는 기전
이해뿐이며, 판단은 프로덕션 answerable 185문항의 분포가 드러난 뒤에 한다. ③은 `cause` 라벨이 잡는다.

## 범위 (진입점)

**신규·변경 엔드포인트 없음. SSE 계약 무변경** — 이벤트 구조·필드 모두 그대로이고 `reason` 문구만
사유가 하나 늘어난다. `pnpm openapi:export` 결과가 달라지지 않아야 한다(contract 테스트가 지킨다).

| 진입점 | 변경 |
|---|---|
| `llm-provider.port.ts` | `streamAnswer`의 yield를 `LlmAnswerChunk` 판별 유니온으로 — `{kind:'verdict', insufficientEvidence, missingAspects}` \| `{kind:'delta', text}`. verdict는 **최대 1회**이고 **어떤 delta보다 먼저** 온다. **미방출을 허용한다** — 게이트 없음(fail-open)이 유효한 상태다 |
| `prompt-builder.ts` | **`qa-v6`.** 규칙 3을 구조화 판정으로 바꾼다(산문 거부 금지 — `insufficient_evidence`·`missing_aspects`로 낸다) + 합성 규칙 2개(비교 질문은 각 대상의 근거로 구성한다 / 한 축의 근거가 없어도 나머지 축으로 답한다). 후자 둘은 **효과 미실측**이다(위 위험) |
| `openai.provider.ts` | `response_format: json_schema` + flag-first 스키마. `answer` 문자열을 증분 파싱해 delta로 흘리고, 플래그가 true면 **파싱하지도 델타를 내지도 않는다**. `minItems`는 structured outputs가 지원하지 않으므로 aspects 비어 있음은 **코드가 판정한다** |
| `anthropic.provider.ts` | **구조화 미적용 — verdict를 내지 않는다.** 프로덕션 미등록이고(위 실측) 포트가 미방출을 허용하므로 폴백 시 오늘 동작 그대로다 |
| `fake-llm.provider.ts` | verdict를 먼저 yield한 뒤 기존 델타. 기본은 `insufficientEvidence: false` |
| `llm-gateway.ts` | verdict 청크를 소비해 `LlmStreamOutcome.verdict`로 노출. **`firstTokenReceived`는 delta에서만 선다** |
| `conversation-stream.service.ts` | 게이트 ④ 배선 — verdict가 발화하면 답변 영속화 대신 기권 경로(`ABSTAINED` + content 빈 문자열 + 인용 0건)로 가되 **GenerationRun은 기록한다** |
| `metrics.service.ts` | `AbstainReason`에 `insufficient_evidence` 추가 + `rag_generation_gate_total{cause="model_verdict"\|"empty_aspects"}` 신설. 두 cause의 합은 `rag_abstains_total{reason="insufficient_evidence"}`와 같다 |
| `llm.config.ts` | `answerabilityGateEnabled`(`LLM_ANSWERABILITY_GATE_ENABLED`, 기본 **true**) — 기본값 코드 소유(#156 규약). 기본 on인 이유는 §33 킬스위치와 같다: 배포가 측정 뒤에 있으므로 통과 상태가 기본이고, 미달 시 기본값을 뒤집는 커밋이 곧 롤백이다 |
| `.env.example` · compose | env 1종 (compose는 빈 통과) |
| `docs/architecture.md` | §8에 게이트 4단과 새 기권 사유, §11에 포트 계약 변경, §9 `GenerationRunEntity`의 「답변마다」를 **「LLM 호출마다」**로 |

## Entity / 마이그레이션 변경분

없음 — 기존 `messages.status='ABSTAINED'`와 기존 `generation_runs` 스키마로 판정·기록이 닫힌다.

## 추가 에러코드

없음 — 기권은 오류가 아니라 정상 종결(`answer.abstained`)이다(§28 계승). 플래그 확정 전 파싱 실패는
기존 `LlmProviderError` → 게이트웨이 폴백이며, 소진 시에만 기존 `LLM_UNAVAILABLE`이다.

## 수용 기준 (= 동결할 시나리오, Definition of Done)

**게이트가 발화하면 기존 기권 경로로 간다**

1. verdict의 `insufficientEvidence`가 true면 스트림이 `answer.abstained`로 끝난다 (e2e)
2. 그 메시지 status가 `ABSTAINED`다 (e2e)
3. 그 메시지 content가 **빈 문자열**이다 (e2e — LLM 텍스트가 남지 않는다)
4. `reason`이 LLM 텍스트가 아니라 `insufficient_evidence` 템플릿 문구다 (e2e)
5. 그 문구가 `beyond_cutoff` 문구와 **다르다** (e2e — §28 기준 5와 같은 이유)
6. `rag_abstains_total{reason="insufficient_evidence"}`가 오른다 (e2e)
7. 그 기권은 `answer.delta`를 **하나도** 내지 않는다 (e2e — 이벤트 0건)
8. 그 메시지의 `message_citations`가 **0건**이다 (e2e — 만성 아토피 사례의 직접 단언)

**생성 게이트 기권은 검색 게이트 기권과 구분된다**

9. 생성 게이트 기권의 `retrieval.completed`는 근거를 **싣고** 있다 (e2e)
10. 검색 게이트 기권의 `retrieval.completed`는 여전히 **빈 배열**이다 (e2e — §29 기준 3 회귀)
11. 생성 게이트 기권에 `GenerationRun`이 **1건** 기록된다 (e2e)
12. 그 run의 `promptVersion`이 **qa-v6**이다 (e2e)
13. 그 run의 `retrievalPolicyVersion`이 그 요청이 실제로 탄 정책 문자열이다 (e2e — §29 기준 7 계승)
14. 검색 게이트 기권에는 `GenerationRun`이 **기록되지 않는다** (e2e — 두 축의 구분자이자 기존 동작 회귀)

**verdict가 없으면 게이트는 발화하지 않는다 (fail-open)**

15. verdict를 내지 않는 프로바이더의 스트림은 **정상 답변으로 완료**된다 (e2e)
16. `LLM_ANSWERABILITY_GATE_ENABLED=false`면 프로바이더가 구조화 출력을 **요청하지 않는다** (유닛 — 요청 바디에 `response_format` 없음)
17. 그 모드에서 spec 06·28·29 동결 스위트가 **그대로 통과한다** (e2e — §29 기준 8과 같은 이유)
18. 이 env가 미지정·빈 값이면 게이트가 **켜진다** (유닛 — 코드 기본값 소유)

**빈 `missing_aspects`도 기권시키되 원인을 나눈다**

19. aspects가 비어 있지 않은 발화는 `rag_generation_gate_total{cause="model_verdict"}`를 올린다 (e2e)
20. aspects가 빈 발화는 `{cause="empty_aspects"}`를 올린다 (e2e)
21. 두 경우의 `reason` 문구가 **같다** (e2e — 원인 구분은 내부 축이고 사용자에게는 같은 사실이다)
22. `missing_aspects` 값이 **어느 SSE 이벤트에도 실리지 않는다** (e2e — `missingInformation`은 빈 배열 유지)

**스트리밍은 버퍼링하지 않는다**

23. `insufficientEvidence`가 false면 `answer` 필드가 증분 델타로 흘러 `answer.delta`가 **2개 이상** 나온다 (e2e — fake가 2회 이상 yield)
24. 플래그 확정 **전** 파싱 실패는 `LlmProviderError`로 던져진다 (유닛)
25. 그 실패에서 게이트웨이는 **다음 프로바이더로 폴백한다** (유닛 — verdict만 받고 죽은 시도도 포함)
26. 플래그 확정 **후** 본문이 잘려도 지금까지 흘린 델타로 `answer.completed`한다 (유닛 — 오늘의 출력 상한 잘림 처리와 같다)

**PATIENT_GUIDANCE**

27. PATIENT_GUIDANCE에서 게이트가 발화하면 `clinical_guidances` 행이 **생기지 않는다** (e2e)
28. 그 경우에도 `patient_profile_snapshots` 행은 **남는다** (e2e — 스냅샷은 게이트 앞에서 이미 고정되며, 스냅샷만 남는 상태는 FAILED로 이미 존재한다)

fixture 규약: e2e는 **실 모델의 판정을 재현하지 않는다** — fake 프로바이더가 verdict를 결정적으로
방출하고, 테스트는 그 verdict가 시스템을 어떻게 움직이는지만 동결한다(§29 fake 리랭커와 같은 이유:
외부 유료 API는 fake 치환 없이 동결이 성립하지 않는다). 근거 청크는 프로덕션 원문이 아니라 **구조를
모방한 합성 텍스트**이며, 기준 8의 「무관 근거를 인용한 거부」는 fake가 델타와 verdict를 함께 내도록
구성해 만든다 — 인용이 실제로 걸리는 경로를 태워야 0건 단언이 의미를 갖는다.

## Out of scope

- **리랭크 점수 컷 값 변경** — 위 판단표 그대로 9를 유지한다. 컷을 다시 볼 이유가 생기면 `eval:rag`
  확장이 선행 조건이다(아래)
- **`eval:rag`에 생성 게이트 판정 포함** — 현재 `rag-eval.service.ts`는 `RetrievalService`·`RERANKER`만
  주입받고 생성을 호출하지 않아(`streamAnswer` 참조 0건) **검색 게이트만 잰다.** 즉 「컷을 낮추면 생성
  게이트가 얼마나 받아내는가」를 측정할 수단이 지금은 없다. 컷을 다시 볼 때 필요한 확장이다
- **질의 분해** — 별도 spec. 근거 개수를 통제해도 이기지만 마진이 1문항이라 실트래픽 A/B가 먼저다.
  설계는 **B**(하위 질의 후보를 병합해 원 질문으로 1회 재정렬)가 낫다고 실측됐고 — A와 동점(0.83)에
  리랭크 호출 1/3·토큰 36% 절감 — 무엇보다 **점수가 하나뿐이라 점수 게이트를 건드리지 않는다**(A는
  최댓값 규칙 탓에 컷 9에서 구조화 기권이 0.92 → 0.67로 떨어졌다). 이 스펙은 A의 최댓값 문제를
  고려해 설계할 필요가 없다
- **빈 `missing_aspects`의 재호출·무효화** — 원인 구분이 선행이다(위 판단표). `cause` 분포가 드러난
  뒤에 처방을 고른다
- **별도 사전 충분성 판정 포트** — 리랭커·구조화기처럼 단발 포트를 하나 더 두는 안. 이 스텝의 동기와
  어긋난다: 그것은 **새 판단을 만드는 것**이고 이 스텝은 이미 내려진 판단의 승격이다. 호출도 1회 는다
- **anthropic 구조화 출력** — 프로덕션 미등록이고, 포트가 verdict 미방출을 허용해 폴백 동작이 오늘과
  같다. 등록되면 그때 판단한다
- **`missing_aspects`의 사용자 노출·FE 표시 변경** — 재질의 유도는 실익이 있지만 SSE 계약과 화면
  작업이 딸린다. 값이 관측 경로에 쌓인 뒤 그 내용을 보고 판단한다
- **groundedness judge의 실시간 경로 편입** — 이 게이트는 답을 **쓰는 쪽**의 자기 판정이고, judge는
  쓰인 답을 채점한다. 요청 경로에 넣으면 호출이 하나 더 붙는다
