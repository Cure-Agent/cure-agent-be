# 05. Guideline·Evidence + 인제스트

## 목표

한의 임상 지침을 구조화 입력(JSON)으로 인제스트해 버전·섹션·근거 청크(+임베딩)로 저장하고, 지침 탐색 화면(§5.4)이 소비할 조회 API 4종을 제공한다. 저장까지가 이번 범위이며, 벡터 유사도 검색은 6단계 retrieval의 몫이다 (§12: exact search 전제).

## 범위 (엔드포인트)

| API | Request | Response data | 참조 |
|---|---|---|---|
| GET /guidelines | ListGuidelinesQueryDto | GuidelineSummaryResponseDto[] + page | §5.3 §6 |
| GET /guidelines/{guidelineId} | – | GuidelineDetailResponseDto | §5.4 |
| GET /guidelines/{guidelineId}/evidence | ListEvidenceQueryDto | EvidenceSummaryResponseDto[] + page | §5.4 |
| GET /evidence/{evidenceId} | – | EvidenceDetailResponseDto | §5.4 §7 |

- 4종 모두 보호 라우트(로그인 필요). 목록은 불투명 커서 + PageMeta (§10.4).
- `EvidenceSummaryResponseDto`는 `EvidenceDetailResponseDto`(§7)의 부분집합으로 구현 시 정의 (excerpt 축약 + 등급 포함).
- **인제스트**: `scripts/ingest-guidelines.ts <입력.json>` — 입력은 구조화 JSON:
  `{ title, publisher, version, publishedAt, sourceUrl, sections: [{ path[], title, order, chunks: [{ content, recommendationNumber?, recommendationGrade?{system,code,label}, evidenceLevel?, pageStart?, pageEnd? }] }] }`
  실행마다 `IngestionRun`(결과·실패 사유) 기록.
- **임베딩**: `infrastructure/embedding` 포트 신설 (vector 1536). 이번 스텝은 결정적 fake 구현만 배선하고, 실 프로바이더 연결은 6단계에서.

## Entity / 마이그레이션 변경분

- 신규 테이블 (§9): `guidelines`, `guideline_versions`, `guideline_sections`, `evidence_chunks`(embedding vector(1536), content_hash), `ingestion_runs`
- 멱등성 제약: 동일 guideline_version 내 chunk `content_hash` unique
- guideline은 `(title, publisher)` 기준 upsert, 동일 version 재인제스트는 콘텐츠 변경 없이 skip

## 추가 에러코드

- 없음 — 공통 `NOT_FOUND`/`BAD_REQUEST`로 충분 (필요 발견 시 spec 개정 후 재동결)

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

1. 샘플 JSON 인제스트 → guideline/version/section/chunk/IngestionRun이 저장되고, 모든 chunk에 1536차원 임베딩이 존재한다
2. 같은 입력 재인제스트 → chunk 중복 저장 없음(멱등), IngestionRun은 새로 1건 기록된다
3. GET /guidelines: 목록 반환 + 커서 페이지네이션 동작 (size 제한 → hasNext=true → nextCursor로 다음 페이지 조회 시 나머지 반환, 중복 없음)
4. GET /guidelines?query=: 제목 부분일치 필터
5. GET /guidelines/{id}: 현재 버전 정보를 포함한 상세, 미존재 id → 404 NOT_FOUND 봉투
6. GET /guidelines/{id}/evidence: 섹션 경로와 권고등급(RatingResponseDto)이 포함된 목록
7. GET /evidence/{id}: sectionPath·excerpt·sourceUrl 포함 상세, 미존재 id → 404
8. 미인증 접근 시 4종 모두 401 UNAUTHORIZED

## Out of scope

- PDF 파싱(`document/pdf-parser`, `guideline-chunker`) — P1. 이번 입력은 구조화 JSON으로 한정한다
- 벡터 유사도 검색 API·retrieval 정책·실 임베딩 프로바이더 (6단계)
- 지침 SUPERSEDED 전환 운영 플로우, evaluation (P1)
- FE 화면 (8단계)
