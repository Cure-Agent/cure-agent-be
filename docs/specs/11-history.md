# 11. History (대화 관리)

> BE + FE 양 레포. 동결 테스트 — **Codex 작성 / Claude 리뷰·구현** (§15 교차 작성).
>
> **2026-08-02 개정**: FE 전용 `/history` 화면을 폐지하고 대화 관리 기능(검색·이름 변경·보관)을
> `/assistant` 대화 목록으로 통합했다. 과거 대화 열람은 08의 어시스턴트 화면 계약(ChatPanel의
> 저장 메시지·인용 복원)이 상위 호환으로 커버한다. BE 범위·기준 1~5는 변경 없음.

## 목표

§5.7 대화 관리를 활성화한다: 대화명 변경·보관/해제·목록 필터(status·query)를 additive로 추가하고,
FE는 `/assistant` 대화 목록에 검색·이름 변경·보관을 통합한다. 과거 답변 재현성 계약(§5.7)은 기존 저장분을 그대로 사용한다.

## 범위 (BE) — §5.7 표 참조

| API | Request | Response data |
|---|---|---|
| PATCH /conversations/{id} | UpdateConversationRequestDto | ConversationSummaryResponseDto |
| POST /conversations/{id}/archive · /unarchive | – | null |
| GET /conversations (기존 확장) | ListConversationsQueryDto + `status?`·`query?` | 기존 그대로 |

- `UpdateConversationRequestDto { title: string }` — 1~100자 (§6에 본 spec으로 확정 편입)
- `ListConversationsQueryDto`에 additive: `query?`(제목 부분일치, §6 기존 계약 구현) + `status?: 'ACTIVE'|'ARCHIVED'`
  — **미지정 시 전체 반환(기존 동결 동작 불변)**
- 스코프는 기존 그대로 clinicianId (§4.4) — 타 clinician 404, 미인증 401
- archive/unarchive는 멱등(이미 해당 상태여도 200 null)

## Entity/마이그레이션 변경분

- 없음 — conversations.status(ACTIVE/ARCHIVED enum)·title 기존 컬럼 사용

## 추가 에러코드

- 없음 — NOT_FOUND/VALIDATION_FAILED/UNAUTHORIZED 공통 코드만 사용

## 수용 기준 — BE e2e (스텁 상태에서 전부 실패해야 함)

1. PATCH {title:'수정된 제목'} → 200, data.title 반영. GET /conversations/{id} 재조회로 동일 확인. 빈 title('') → 422 VALIDATION_FAILED 봉투
2. POST archive → 200 **data null**, GET 상세 재조회 status='ARCHIVED'. unarchive → 200 **data null**, 재조회 status='ACTIVE' 복귀. 이미 ACTIVE인 대화 unarchive → 200 data null (멱등) — 응답 본문의 status 단언 금지(§5.7 응답 계약은 null)
3. GET ?status=ARCHIVED → 보관 대화만(보관 전 목록에는 존재 선행 확인). ?status=ACTIVE → 보관 대화 미포함. 미지정 → 둘 다 포함
4. GET ?query= 제목 부분일치 대화만 반환(불일치 검색어는 0건)
5. 타 clinician 계정: PATCH·archive → 404 (소유 계정 200 선행). 쿠키 없는 PATCH → 401

## 수용 기준 — FE vitest (2026-08-02 개정 — /assistant ConversationList 대상)

6. 검색: ConversationList의 input aria-label='대화 검색' 제출(버튼 name='검색') → GET /conversations 재조회의 query 파라미터 검증 (MSW 요청 URL 단언)
7. 제목 변경: 선택된 대화 항목에서 버튼 name='이름 변경' → input 라벨 '대화 제목'에 입력 → 제출 버튼 name='저장' → PATCH body {title} 검증 → 갱신 제목 렌더
8. 보관: 선택된 대화 항목에서 버튼 name='보관' 클릭 → POST /conversations/{id}/archive 호출 검증
9. 보관 표시: status=ARCHIVED 대화는 목록 항목에 '(보관됨)' 표기

> 개정 전 기준 6(항목 선택 → 상세 영역 메시지 렌더)은 08 어시스턴트 화면의 ChatPanel 저장 메시지
> 복원 계약이 커버하므로 별도 기준에서 제외한다.

## Out of scope

- 보관 대화의 스트림 전송 차단(§5.7에 규정 없음 — 전송 허용 유지), totalCount(§10.4 확정 사양), 재현성 스냅샷 신규 저장(기존 계약), 히스토리에서 guidance 재조회 UI(GET /clinical-guidance/{id}는 10단계 제공분)
- 보관 해제 UI(BE unarchive API만 제공 — 개정 전과 동일), 목록 status 필터 UI
