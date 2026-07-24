# 06. Conversation·Message + SSE + LLM 게이트웨이

## 목표

지침 QA 대화를 생성하고, 질문을 SSE(§8 계약 전체)로 스트리밍 응답한다: retrieval(pgvector cosine, 5단계 저장분) → LLM 게이트웨이(4단 방어) → 인용·GenerationRun 영속화. 끊김 복구 계약(§8)의 서버측 전제(메시지 상태 조회)까지 제공한다.

## 범위 (엔드포인트)

| API | Request | Response data | 참조 |
|---|---|---|---|
| POST /conversations | CreateConversationRequestDto | ConversationSummaryResponseDto | §5.3 §6 |
| GET /conversations | ListConversationsQueryDto | ConversationSummaryResponseDto[] + page | §5.3 |
| GET /conversations/{id} | – | ConversationDetailResponseDto | §5.3 |
| GET /conversations/{id}/messages | ListMessagesQueryDto | MessageResponseDto[] + page (시간순) | §5.7 §8복구 |
| POST /conversations/{id}/messages/stream | SendMessageRequestDto | SSE 이벤트 (§8, 봉투 미적용) | §8 |
| POST /messages/{messageId}/feedback | SubmitFeedbackRequestDto | null | §5.3 |

- 전부 보호 라우트. **conversation 계열은 clinician 스코프 강제(§4.4)** — 타인 리소스는 404.
- `type=PATIENT_GUIDANCE`는 9단계 활성화 전까지 400 BAD_REQUEST (DTO enum은 계약 유지).
- SSE: `message.accepted`(첫 이벤트) → `retrieval.started/completed` → `answer.delta(messageId, seq)` → `answer.completed | answer.abstained | error`. heartbeat 주석 15s, `X-Accel-Buffering: no`. 근거 0건이면 abstain.
- **LLM 게이트웨이(§11 4단 방어)**: `infrastructure/llm` — 포트 + provider-router(우선순위 폴백) + circuit-breaker + rate-limit-block + retry. **이번 스텝은 결정적 FakeLlmProvider만 기본 배선** — 답변 텍스트에 `[n]` 인용 마커 포함, 마커→MessageCitation 영속화. GenerationRun에 실사용 프로바이더·promptVersion·retrievalPolicyVersion·latency·traceId 기록.
- retrieval: `infrastructure/retrieval` — 질문 임베딩(기존 포트) → evidence_chunks cosine 유사도 exact search top-5, `filters.guidelineIds/recommendationGrades/evidenceLevels` 적용.

## Entity / 마이그레이션 변경분

- 신규 (§9): `conversations`(clinicianId, clinicId, type, patientId?, title, status), `messages`(role, content, status[STREAMING/COMPLETED/ABSTAINED/FAILED/CANCELLED], answerKind?, clientRequestId? unique), `message_citations`(marker, quote), `generation_runs`(provider, model, promptVersion, retrievalPolicyVersion, latencyMs, tokenUsage, traceId), `answer_feedbacks`(rating, reasonCodes, comment, unique(messageId, clinicianId) — 재제출은 갱신)

## 추가 에러코드

- 없음 — 기존 `DUPLICATE_CLIENT_REQUEST`(409)·`LLM_UNAVAILABLE`(503)·공통 코드로 충분

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

1. POST /conversations(GUIDELINE_QA) → 201 CREATED + Summary(기본 title). PATIENT_GUIDANCE → 400
2. GET /conversations: 본인 대화만 목록 (커서 페이지네이션 동작)
3. 타 계정 대화에 GET 상세/messages/stream/feedback → 전부 404 (§4.4 첫 실전 검증)
4. 스트리밍 해피패스: 이벤트 순서(accepted→retrieval.started→completed(evidence≥1)→delta(seq 0부터 연속, messageId 일치)→answer.completed). 완료 메시지에 citations≥1(marker·evidenceId 유효), DB에 user/assistant 메시지·citations·GenerationRun(provider·traceId) 저장
5. 같은 clientRequestId 재요청 → 409 DUPLICATE_CLIENT_REQUEST 봉투, 메시지 추가 생성 없음
6. 존재하지 않는 guidelineIds 필터 → 근거 0건 → answer.abstained + 메시지 ABSTAINED 저장
7. GET messages: 시간순 반환, 4·6의 최종 상태(COMPLETED/ABSTAINED) 반영 — §8 복구 폴백 성립
8. 프로바이더 폴백: [실패 프로바이더, 정상 프로바이더] 구성 시 답변 완료 + GenerationRun.provider = 2순위
9. 전 프로바이더 실패 → error 이벤트(code=LLM_UNAVAILABLE, retryable=true, traceId 존재) + 메시지 FAILED
10. 피드백: 제출 → 저장, 같은 메시지 재제출 → 단일 행 갱신. 미인증 401
11. 스트리밍 중 클라이언트 abort → 메시지 CANCELLED로 정리 (§8-4)

## Out of scope

- 실 LLM 프로바이더(OpenAI/Anthropic) 연동 — 후속 **spec 13** (API 키 필요. 07 번호는 FE 파운데이션이 사용)
- response-cache (§11 규칙만 확정, 구현 P1)
- PATIENT_GUIDANCE·PatientProfileSnapshot·ClinicalGuidance (9단계)
- PATCH /conversations(제목 변경)·archive/unarchive (History 스텝)
- heartbeat의 e2e 검증(구현만), FE 화면
