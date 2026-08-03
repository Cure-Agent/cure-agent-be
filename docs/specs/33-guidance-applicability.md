# 33. guidance-v1 — 참고안 적용 판단 구조화 (환자 프로필 × 인용 근거)

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 테스트로 동결되며, 구현 중 수정할 수 없다.

## 목표

PATIENT_GUIDANCE 참고안(§5.6)을 일반 QA 답변과 실질적으로 차별화한다. 현행 조립은 결정적
재배열이다 — considerations는 인용을 그대로 옮기고 safetyAlerts는 알레르기 문자열 규칙뿐이라,
환자 대화가 프로필을 질문 앞에 붙이는 것(§5.6) 외에 더 주는 게 없다. spec 10이 Out of scope로
예약한 「실 LLM 구조화 출력(JSON mode)」 자리를 채운다: **인용 근거 × 환자 스냅샷의 적용
판단**(적용/주의/해당없음)을 LLM 구조화 출력으로 생성하되, 모든 항목이 근거 마커와 프로필
필드 **두 다리**를 명시하도록 출력 스키마와 결정적 검증기로 강제한다.

## 판단 근거 (2026-08-03 사용자 확정 — qa-v5 완화가 아니라 가이던스 스테이지)

| 쟁점 | 판단 |
|---|---|
| qa-v5의 종합 판단 금지를 완화? | **불가.** spec 32 실측이 산 규칙이다 — unsupported 지배 패턴 ②가 종합 판단 창작이었고, qa-v4의 반쪽 조치는 결함을 miscited→unsupported로 옮기기만 했다. QA 프롬프트는 일반 대화와 공유되므로 완화는 전역 퇴행이다 |
| 창작과 적용의 구분 | 「양약보다 소요산이 더 적절」(전제가 컨텍스트 밖 — **창작**, 계속 금지)과 「[2]는 임신부 금기인데 이 환자 임상 메모에 임신 8주 — **주의**」(전제 둘 다 입력 안 — 검증 가능한 연역)는 다른 범주다. 후자만, 두 다리를 드러낸 형태로만 허용한다 |
| 어디서 | QA 생성이 아니라 답변 완료 후 가이던스 조립 스테이지. qa-v5·심판 rubric v3·185문항 전후 비교는 오염되지 않는다 |

## 범위 (진입점)

**신규·변경 엔드포인트 없음.** 스트림 완료 시 가이던스 조립 경로만 변경.

| 진입점 | 변경 |
|---|---|
| `infrastructure/llm/guidance/` (신규) | `guidance-structurer.port.ts` · `openai-guidance-structurer.ts`(json_object — 리랭커 선례, 프롬프트 버전 `guidance-v1`) · `fake-guidance-structurer.ts`(결정적 — 인용 마커별 1항목, patientFactors는 값 있는 임상 필드 전부) · `guidance-structurer.factory.ts`(리랭커 팩토리 선례: OPENAI_API_KEY 있으면 실물, 없으면 fake) |
| `conversation-stream.service.ts` | 답변 완료 후·영속화 tx **전**에 structurer 호출(상한 20s — TTFT 실측 ~9.5s(§11) + 카드 1장 출력). 입력은 답변 텍스트 + **인용된 청크 원문**(quote 발췌 아님, 마커 유지) + 복호화 스냅샷 — 새 검색·새 근거 없음. 인용 0건이면 호출 자체를 생략. 실패·타임아웃·검증 전멸 → null 폴백, 스트림 실패로 번지지 않는다(리랭커 폴백 선례, spec 29 기준 6) |
| `clinical-guidance-composer.service.ts` | 구조화 결과를 결정적 검증 후 considerations로 채용: ⑴ 항목 markers ⊆ 답변 인용 마커 ⑵ patientFactors ⊆ 값이 채워진 스냅샷 임상 필드명(§4.5 payload) ⑶ applicability ∈ 3값 — 위반 항목은 폐기, 잔존 0이면 현행 결정적 조립으로 폴백. summary·safetyAlerts·missingInformation은 **결정적 로직 불변** |
| schema · DTO · mapper | `GuidanceConsiderationJson`·ResponseDto에 `applicability?`·`patientFactors?: string[]` additive(§7 개정 — 기존 행·폴백 행에는 없음). `clinical_guidances.composerVersion` 컬럼 |
| `scripts/eval-guidance.ts` + `domain/evaluation/` | 아래 측정 계획의 실행체 — 수용 기준 밖(동결 대상 아님) |
| `metrics.service.ts` | `guidance_compose_total{outcome=structured\|fallback\|skipped}` + duration 히스토그램 |

**guidance-v1 프롬프트 계약** (요지 — 검증기가 못 잡는 축은 프롬프트가 막는다):

```
이미 작성된 근거 기반 답변을 환자 프로필에 대응시킨다. 새 임상 내용을 만들지 않는다 —
처방명·혈자리·용량·수치는 인용 근거 원문에 있는 것만 쓴다. 각 항목에 근거 마커와 그 판단이
딛고 선 환자 프로필 필드를 함께 명시한다. 판단은 적용/주의/해당없음 3값뿐이다 — 근거 사이의
우선순위·비교 우위를 만들지 않는다. 근거의 조건·금기가 프로필의 어느 값과 만나는지만
서술하고, 선택은 의료인의 판단으로 남긴다.
```

**출력 계약** — 검증기는 이 형태만 통과시키고, 어긋난 **항목만** 폐기한다(전멸 시 폴백):

| 필드 | 통과 조건 |
|---|---|
| `applicability` | `APPLICABLE` · `CAUTION` · `NOT_APPLICABLE` 셋 중 하나 (DTO enum 관행 — severity·reviewStatus와 같은 대문자 토큰) |
| `markers` | 답변 인용 마커 번호 배열, **1개 이상** — 근거 다리 |
| `patientFactors` | 프로필 필드명 배열, **1개 이상** — 환자 다리. 어휘는 missingInformation과 **동일한 9개**(출생연도·성별·신장·체중·허리둘레·진단명·투약 목록·알레르기 이력·임상 메모) 중 **값이 채워진 것**만. 두 목록은 같은 어휘의 여집합이다 — 한쪽은 있는 것을, 다른 쪽은 없는 것을 싣는다 |
| `title`·`rationale` | 공백이 아닌 문자열 — spec 10 기준 2의 동결을 구조화 경로에서도 지킨다 |

두 다리를 **1개 이상**으로 못박는 이유: 빈 배열은 부분집합 조건을 자동 통과하므로, 근거도
프로필도 딛지 않은 항목이 검증을 빠져나가 이 스펙의 전제(적용 판단은 두 전제의 연역)가 깨진다.

## Entity / 마이그레이션 변경분

- `clinical_guidances.composer_version` text NOT NULL DEFAULT `'deterministic-v1'` (마이그레이션 0016).
  LLM 경로 채용 시 `'guidance-v1'` — §5.7 재현성 계약(프롬프트 버전 고정)의 가이던스 축.
  응답 DTO에는 노출하지 않는다
- considerations jsonb는 additive 필드만 — 기존 행 그대로 유효, 재적재 없음

## 추가 에러코드

없음 — 폴백 계약이라 사용자 노출 실패가 없다.

## 측정·판정 계획 (배포 전 측정이 채택을 게이트한다 — spec 32 관행)

- `scripts/eval-guidance.ts`(신규, eval-groundedness 관행): 합성 프로필 픽스처 12종(진단·투약·
  알레르기·결측 조합) × answerable 문항 표집 ≈ **30케이스**. 실 생성(qa-v5) → guidance-v1
  구조화 → 리포트를 docs/rag-eval/에 커밋. 비용 ≈ $0.2
- 기계 지표: 두 다리 검증 통과율 · 폴백률 · 호출 지연 p50/p90 (상한 20s 실측 재검토 겸)
- 육안 전수 판정 — 케이스를 30으로 잡은 이유(LLM 심판 없이 전수 가능한 규모). **채택 게이트**:
  ⑴ 인용 근거·프로필 밖 구체 임상 항목 창작 **0건** ⑵ 프로필 오독(사실과 반대 방향 적용) **0건**
  ⑶ 폴백률 10% 미만(리랭커 파싱 실패 0/74 선례)
- 미달 시: 실물 팩토리 등록만 되돌려 결정적 조립을 유지하고 리포트를 남긴다 — 폴백이 기본
  경로라 롤백 비용이 없다

## 수용 기준 (= 동결할 시나리오, Definition of Done)

1. PATIENT_GUIDANCE 스트림 해피패스(fake structurer): `answer.completed.guidance`의
   considerations 각 항목에 applicability(3값)·patientFactors가 있고, patientFactors ⊆
   스냅샷의 값 있는 임상 필드명, 항목 citations ⊆ 답변 인용. DB `composerVersion='guidance-v1'` (e2e)
2. 검증기 유닛 — 위 출력 계약의 항목별 폐기 규칙을 각각 단언한다: ⑴ 답변 인용에 없는 마커
   ⑵ 값이 채워지지 않은 프로필 필드 ⑶ 3값 밖 applicability ⑷ 빈 markers ⑸ 빈 patientFactors
   ⑹ 공백 title·rationale ⑺ 유효 항목과 무효 항목이 섞이면 **유효한 것만 남는다**
   ⑻ 전 항목 폐기 시 폴백 신호 반환
3. 구조화 실패 주입(예외 fake) → 결정적 폴백: `composerVersion='deterministic-v1'`,
   considerations는 현행 인용 재배열 형태, `answer.completed` 정상 도달 — spec 10 동결 기준
   2·4가 계속 통과한다 (e2e)
4. 호출 상한 20s 초과 → 폴백 (유닛 — fake timer)
5. GUIDELINE_QA 스트림에서 structurer 호출 0회 (주입 fake 호출 카운트 — spec 10 기준 5의
   guidance 부재 동결과 함께)
6. fake 구조화 **성공** 경로에서도 알레르기 결정적 safetyAlert가 남아 있다 — LLM 출력이
   결정적 안전 규칙을 대체하지 못한다 (e2e)
7. guidance 프롬프트 유닛: 버전 상수 `'guidance-v1'`, 「새 임상 내용을 만들지 않는다」·
   두 다리 명시 요구·「우선순위·비교 우위를 만들지 않는다」 포함. qa-v5 SYSTEM_PROMPT
   불변은 spec 32 동결 유닛이 이미 보장한다

## Out of scope

- **qa-v5(QA 시스템 프롬프트) 변경** — 근거 계약 불변이 이 스펙의 전제다
- summary·safetyAlerts·missingInformation의 LLM 생성 — 이번 범위는 considerations만
- LLM 심판 기반 가이던스 평가 자동화·심판 루브릭의 프로필 grounding 확장 — 첫 사이클은
  육안 전수, 케이스 증량 시 별도 스텝
- FE 렌더(applicability 배지 등) — additive 필드라 기존 FE 동결 불변, 표시는 FE 레포 스펙
- 검토 흐름(reviews)·멀티턴 맥락 활용 변경 없음
