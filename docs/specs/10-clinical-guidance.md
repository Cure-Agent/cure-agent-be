# 10. ClinicalGuidance + 의료인 검토

> BE + FE 양 레포. 동결 테스트 — **Codex 작성 / Claude 리뷰·구현** (§15 교차 작성).

## 목표

PATIENT_GUIDANCE 대화를 활성화한다: 스트림 시작 시 환자 스냅샷을 자동 캡처(§5.6)하고, 답변 완료 시 구조화된 ClinicalGuidance(DRAFT)를 생성해 `answer.completed.guidance`(§8)로 전달하며, 의료인 검토(ACCEPTED/MODIFIED/REJECTED)를 기록한다. "처방 확정"이 아닌 근거 기반 참고+검토 흐름(§5.6)이 계약이다.

## 범위 (BE)

| API | Request | Response data | 참조 |
|---|---|---|---|
| POST /conversations (기존 확장) | type=PATIENT_GUIDANCE + patientId 허용 | ConversationSummaryResponseDto | §5.6 |
| POST /clinical-guidance/{guidanceId}/reviews | ReviewClinicalGuidanceRequestDto | ClinicalGuidanceResponseDto | §5.6 §6 |
| GET /clinical-guidance/{guidanceId} | – | ClinicalGuidanceResponseDto | 히스토리 재진입용 (§5.6 보완) |

- PATIENT_GUIDANCE 생성: patientId 필수(누락 400), 환자는 clinicId 스코프 검증 — 타 클리닉/미존재 404. GUIDELINE_QA는 기존 그대로.
- **스트림(§8) 확장**: type=PATIENT_GUIDANCE면 ①생성 시작 시 `PatientSnapshotService.capture` ②환자 프로필(복호화)을 LLM 컨텍스트에 합성 ③assistant 메시지 answerKind=CLINICAL_GUIDANCE ④완료 시 guidance 행 생성(메시지·스냅샷 참조) 후 `answer.completed.guidance` 포함. abstain이면 guidance 없음. GUIDELINE_QA 스트림은 guidance 미포함(기존 동결 불변).
- guidance 구조화(§7 DTO 그대로): summary(답변 요약), considerations[{title, rationale, citations[]}](인용 근거 기반), safetyAlerts[{severity, description, citations:[]}](알레르기 등 결정적 규칙 — 실 LLM 구조화는 spec 07-LLM에서 대체), missingInformation[](누락 프로필 필드), reviewStatus=DRAFT, patientProfileSnapshotId.
- **검토**: DRAFT에서만 가능 — 이미 검토됐으면 409 `GUIDANCE_ALREADY_REVIEWED`. 성공 시 reviewStatus 갱신 + GuidanceReview 행(clinicianId, decision, note). 스코프는 clinicId, 타 클리닉 404.
- Entity(§9): clinical_guidances, guidance_reviews 신규 (마이그레이션 0004).

## 범위 (FE)

- stream reducer에 `guidance` 필드 추가(additive — 기존 동결 assertion 불변)
- features/request-clinical-guidance: 환자 상세에 "임상 참고 대화 시작" → POST /conversations(type=PATIENT_GUIDANCE, patientId) → /assistant로 이동(해당 대화 선택)
- features/review-clinical-guidance: GuidanceCard(summary·considerations·safetyAlerts·missingInformation·reviewStatus 배지) + 검토 폼(ACCEPTED/MODIFIED/REJECTED + note) → reviews API → 배지 갱신, 409 시 안내
- ChatPanel: answer.completed.guidance 수신 시 GuidanceCard 렌더

## 추가 에러코드

- 없음 — `GUIDANCE_ALREADY_REVIEWED` 기등록(§10.2), 나머지 공통 코드

## 수용 기준 — BE e2e (스텁 상태에서 전부 실패해야 함)

1. POST /conversations {type:PATIENT_GUIDANCE, patientId} → 201 (9단계의 400 제거). patientId 누락 → 400, 타 클리닉 환자 → 404(소유 클리닉 201 선행)
2. PATIENT_GUIDANCE 스트림 해피패스: answer.completed에 guidance 포함 — reviewStatus=DRAFT, patientProfileSnapshotId 존재, summary 비어있지 않음, considerations≥1(citations 포함), DB에 clinical_guidances 1행+스냅샷 1행, 메시지 answerKind=CLINICAL_GUIDANCE
3. 스냅샷 불변성: 스트림 완료 후 환자 PATCH로 수정해도 해당 스냅샷 payload(복호화)는 생성 당시 값 유지
4. 알레르기 보유 환자 → guidance.safetyAlerts에 해당 알레르기 언급 항목 ≥1
5. GUIDELINE_QA 스트림 → answer.completed에 guidance 없음
6. POST reviews {decision:ACCEPTED, note} → 200, reviewStatus=ACCEPTED, DB guidance_reviews 1행(clinicianId·note). GET /clinical-guidance/{id}로 재조회 시 동일 반영
7. 재검토 시도 → 409 GUIDANCE_ALREADY_REVIEWED, 상태 불변
8. 타 클리닉 계정: GET/reviews → 404 (소유 계정 200 선행). 미인증 → 401

## 수용 기준 — FE vitest

9. 환자 상세: "임상 참고 대화 시작" 클릭 → POST /conversations body {type:'PATIENT_GUIDANCE', patientId} 검증 (MSW) + 이동 콜백/라우팅
10. GuidanceCard: summary·considerations(제목·근거)·safetyAlerts(severity)·missingInformation·DRAFT 배지 렌더
11. 검토 폼: MODIFIED + note 제출 → POST reviews body 검증 → 갱신된 reviewStatus 배지 렌더
12. reviews가 409 GUIDANCE_ALREADY_REVIEWED 반환 → role=alert로 서버 message 렌더

## Out of scope

- 실 LLM 구조화 출력(JSON mode)·프롬프트 엔지니어링 — spec 07-LLM
- 검토 이력 목록 UI(단건 최신만), 가이던스 수정본 편집 저장(MODIFIED는 결정 기록만)
- History 화면(11단계), 평가(P1)
