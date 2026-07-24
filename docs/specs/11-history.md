# 11. History (대화 관리 + 히스토리 화면)

> BE + FE 양 레포. 동결 테스트 — **Codex 작성 / Claude 리뷰·구현** (§15 교차 작성).

## 목표

§5.7 대화 히스토리를 활성화한다: 대화명 변경·보관/해제·목록 필터(status·query)를 additive로 추가하고,
FE `/history`를 목록+상세 2-pane으로 구성한다. 과거 답변 재현성 계약(§5.7)은 기존 저장분을 그대로 사용한다.

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

## 수용 기준 — FE vitest

6. HistoryPanel 목록: MSW GET /conversations → 제목 렌더, 항목 선택 → 상세 영역에 해당 대화 메시지(MSW GET messages) 렌더
7. 제목 변경: 선택된 대화에서 '이름 변경' → input 라벨 '대화 제목'에 입력 → 제출 버튼 name='저장' → PATCH body {title} 검증 → 갱신 제목 렌더
8. 보관: 선택된 대화에서 버튼 name='보관' 클릭 → POST /conversations/{id}/archive 호출 검증
9. 검색: input aria-label='대화 검색' 제출(버튼 name='검색') → GET 재조회의 query 파라미터 검증 (MSW 요청 URL 단언)

## Out of scope

- 보관 대화의 스트림 전송 차단(§5.7에 규정 없음 — 전송 허용 유지), totalCount(§10.4 확정 사양), 재현성 스냅샷 신규 저장(기존 계약), 히스토리에서 guidance 재조회 UI(GET /clinical-guidance/{id}는 10단계 제공분)
