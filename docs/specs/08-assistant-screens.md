# 08. 지침 질의 3단 화면 + 지침 탐색 화면

> 구현 레포: **cure-agent-fe**. 동결 테스트는 vitest — **Codex 작성 / Claude 리뷰·구현** (§15 교차 작성).

## 목표

/assistant 3단 화면(대화 목록 | 질문·스트리밍 답변 | 근거 패널)과 /guidelines 탐색 화면을 구현한다. 6단계 SSE 계약(§8)을 7단계 stream-client로 소비하며, 스트리밍 중간 상태는 TanStack Query 밖의 reducer로 관리한다(FE 분리본 §4).

## 범위

- **features/manage-conversation**: useConversations(커서 더보기)/useCreateConversation/useMessages + ConversationList(새 대화·선택)
- **features/ask-guideline**:
  - `model/stream-state.model.ts` — **순수 reducer**: idle → accepted(user/assistant 배치) → retrieving → streaming(delta 누적, **중복·역행 seq 무시**) → completed | abstained | error(retryable). §8 이벤트가 입력.
  - `api/send-message.ts` — postStream 래퍼 (clientRequestId는 crypto.randomUUID())
  - `ui/chat-panel.tsx` — 메시지 타임라인 + 입력 + 스트리밍 버블 + abstain 안내 + **오류 시 재시도 버튼(새 clientRequestId)**. 스트림 비정상 종료 시 messages 쿼리 invalidate(§8 복구 폴백).
- **widgets/evidence-inspector** (assistant·guidelines 공용): evidence 목록 렌더, citation **marker 선택 → 해당 근거 하이라이트**
- **features/filter-guidelines**: useGuidelines(query 검색)/useGuideline/useGuidelineEvidence + /guidelines 목록(검색창·더보기)·`[guidelineId]` 상세(evidence 목록 → inspector)
- **shared/test**: MSW 기반 테스트 인프라(FE 분리본 §5 — API 모킹은 MSW로, 수동 mock 금지) + QueryClientProvider render 헬퍼
- 화면 조립: `app/(protected)/assistant/page.tsx`(3단), `guidelines/page.tsx`, `guidelines/[guidelineId]/page.tsx`

## 추가 에러코드

- 없음 (BE 계약 변경 없음)

## 수용 기준 (= 동결할 vitest, Codex 작성)

1. reducer: accepted → retrieval.completed(evidence 반영) → delta 누적 → answer.completed 전이, content = delta 순서 합
2. reducer: 중복 seq·역행 seq delta는 무시된다 (내용 불변)
3. reducer: answer.abstained → ABSTAINED 반영, error → retryable과 traceId 보존
4. useConversations: MSW 응답 → items·hasNext·nextCursor 노출 (unwrapPage 계약)
5. ConversationList: 목록 렌더 + "새 대화" 클릭 → 생성 API 호출 + onSelect 호출
6. ChatPanel: 질문 제출 → postStream 호출(대화 경로 + content + clientRequestId 포함), delta 수신 시 스트리밍 텍스트 갱신 (postStream 모킹)
7. ChatPanel: abstained → 근거 없음 안내 렌더
8. ChatPanel: error 이벤트 → 재시도 버튼 노출, 클릭 시 **이전과 다른 clientRequestId**로 재전송
9. EvidenceInspector: evidence 목록 렌더 + marker 선택 시 해당 항목 하이라이트 콜백/표시
10. 지침 탐색: 검색어 제출 → query 파라미터로 재조회(MSW 검증), 상세에서 evidence 목록 렌더

## Out of scope

- History 화면·대화명 변경·보관 (11단계), Patient (9단계)
- SSE의 브라우저 E2E(Playwright) — 수동 확인으로 대체
- 근거 상세의 별도 라우트(패널 내 표시로 충분), 디자인 폴리시(최소 스타일)
