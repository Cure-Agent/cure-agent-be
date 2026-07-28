# 21. 지침 코퍼스 관리 API

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.**

## 목표

지침 코퍼스를 API로 **조회·적재·폐기·삭제**한다. 지금 파이프라인은 단방향이라 되돌릴 수단이 없다:

- `GuidelineIngestService`는 동일 버전 재인제스트를 **조용히 skip**한다(`created: false`)
- repository에 삭제·수정 메서드가 **없다**
- `guidelines.status`(ACTIVE/SUPERSEDED)는 있으나 **전환 코드가 없고**, 지침 단위라 버전 단위 폐기가 안 된다

§20에서 파서를 고쳤고 171·324는 아직 PARTIAL이다. 파서는 앞으로도 바뀌므로 **재적재는 예외가 아니라
일상**인데, 지금은 DB를 직접 건드리는 것 말고 길이 없다. **코퍼스를 올리기 전에** 되돌릴 수단이 있어야 한다.

수집·파싱 트리거는 여기 없다 — 770MB·수 분짜리 배치는 HTTP 요청/응답 모양이 아니다. §22 스케줄러의 몫이다.

## 범위 (엔드포인트)

전부 **ADMIN 역할** 필요. 관리 화면이 소비할 계약이므로 OpenAPI에 **포함**한다(제외하지 않는다).

| API | Request | Response data | 동작 |
|---|---|---|---|
| GET /admin/guidelines | ListAdminGuidelinesQueryDto | AdminGuidelineSummaryResponseDto[] + page | 지침별 버전 수·활성 revision·청크 수 |
| GET /admin/guidelines/{guidelineId}/versions | – | AdminGuidelineVersionResponseDto[] | 버전 이력 (revision·status·contentHash·청크 수) |
| POST /admin/guidelines/ingest | GuidelineIngestInput (§5 계약 그대로) | AdminIngestResponseDto | 파싱된 JSON 적재 |
| PATCH /admin/guideline-versions/{versionId} | UpdateVersionStatusRequestDto | AdminGuidelineVersionResponseDto | ACTIVE ↔ SUPERSEDED |
| DELETE /admin/guideline-versions/{versionId} | – | 204 | 버전·섹션·청크 삭제 |
| GET /admin/ingestion-runs | ListIngestionRunsQueryDto | AdminIngestionRunResponseDto[] + page | 인제스트 이력 |

- 목록은 불투명 커서 + PageMeta (§10.4).
- **인제스트는 파싱된 JSON을 받는다.** §19가 파싱과 적재를 분리한 이유(*"중간 산출물을 눈으로 검토하는
  단계가 인용 정확도의 마지막 방어선"*)를 API에서도 유지한다 — 업로드 전에 사람이 JSON을 본다.
- 문서 1건 적재는 청크 수백 개 + 임베딩 배치 몇 회라 **동기 처리**로 충분하다. 배치가 필요한 수집은 §22.

## Entity / 마이그레이션 변경분

코퍼스가 비어 있어 **백필이 없다** — 스키마를 바로잡을 수 있는 시점이다. 전부 additive이며 1단계 배포로 충분하다(§12).

**역할**
- 신규 enum `clinician_role`: `ADMIN` / `MEMBER`
- `clinicians.role` (`NOT NULL DEFAULT 'MEMBER'`)

**버전 이력**
- 신규 enum `guideline_version_status`: `ACTIVE` / `SUPERSEDED`
- `guideline_versions.revision` (`integer NOT NULL DEFAULT 1`) — **원문 판본이 아니라 우리 처리 회차**다
- `guideline_versions.status` (`NOT NULL DEFAULT 'ACTIVE'`)
- unique 교체: `(guideline_id, version)` → **`(guideline_id, version, revision)`**

`version`은 원문 판본(`"2024-07"`)이고 `revision`은 같은 판본을 다시 파싱한 회차다. 둘을 섞지 않는다 —
지침이 개정되면 `version`이 바뀌고, 우리 파서가 좋아지면 `revision`이 오른다.

### 재적재 의미론 (이 스텝의 핵심)

| 상황 | 동작 |
|---|---|
| 새 지침·새 판본 | `revision=1`, `status=ACTIVE` |
| **동일 `contentHash`** 재적재 | 새 revision 없음, `created=false` — §5 수용 기준 2의 멱등성을 유지한다 |
| **내용이 바뀐** 재적재 | `revision+1`을 `ACTIVE`로 만들고, 직전 revision을 `SUPERSEDED`로 내린다 |

**이전 revision의 청크는 지우지 않는다.** `message_citations.evidence_chunk_id`가 RESTRICT FK라
물리적으로 못 지우기도 하지만, 그보다 **과거 답변은 실제로 그 청크로 생성됐으므로 역사적으로 정확하다.**
지우면 인용이 거짓이 된다.

대신 **검색이 `status='ACTIVE'`인 버전의 청크만 본다** — `infrastructure/retrieval`을 그렇게 고친다.
SUPERSEDED 청크는 새 답변에 인용되지 않고, 과거 인용에서는 계속 조회된다.

### 삭제 의미론

- 인용된 청크가 하나라도 있으면 **409로 거부**하고 아무것도 지우지 않는다 (부분 삭제 금지).
- 인용이 없으면 청크 → 섹션 → 버전 순으로 지운다. 그 지침의 마지막 버전이었다면 `guidelines` 행도 지운다.
- 폐기(`SUPERSEDED`)와 삭제는 다르다 — **폐기가 기본 수단**이고, 삭제는 잘못 적재한 것을 치우는 용도다.

## 추가 에러코드

| 코드 | status | message |
|---|---|---|
| `GUIDELINE_VERSION_CITED` | 409 | 이미 인용된 지침 버전은 삭제할 수 없습니다. 폐기를 사용해주세요. |

나머지는 공통으로 충분하다 — 미인증 `UNAUTHORIZED`(401), 역할 부족 `FORBIDDEN`(403), 미존재 `NOT_FOUND`(404).

## 인증·권한

- `clinicians.role`이 `ADMIN`인 사용자만 `/admin/*`에 접근한다.
- **역할은 access 토큰 페이로드에 넣지 않고 가드가 DB에서 조회한다.** 토큰에 박으면 권한 회수가
  access TTL만큼 지연되고, §4.3의 rotation 설계를 건드리게 된다. 관리 엔드포인트는 트래픽이 없어
  요청당 조회 1회가 무해하다.
- **최초 ADMIN 지정은 수동 `UPDATE`로 한다.** 역할 관리 API는 이번 범위가 아니다(Out of scope).

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

1. 미인증으로 `/admin/*` 접근 → 401 `UNAUTHORIZED`. `MEMBER` 역할로 접근 → **403 `FORBIDDEN`**
   (6개 엔드포인트 전부)
2. `ADMIN`으로 POST ingest → 201, `revision=1` · `status=ACTIVE`로 저장되고 청크에 임베딩이 존재한다
3. **동일 입력 재적재 → 새 revision이 생기지 않고 `created=false`**, `ingestion_runs`만 1건 늘어난다
   (§5 수용 기준 2의 멱등성이 깨지지 않는다)
4. **내용이 바뀐 재적재 → `revision=2`가 `ACTIVE`, `revision=1`은 `SUPERSEDED`로 내려가고
   revision 1의 청크는 그대로 남아 있다**
5. 검색은 `ACTIVE` 버전의 청크만 반환한다 — 4의 상태에서 revision 1의 청크는 검색 결과에 없다
6. GET /admin/guidelines: 지침별 버전 수·활성 revision·청크 수가 나오고 커서 페이지네이션이 동작한다
7. GET /admin/guidelines/{id}/versions: revision 내림차순으로 status·contentHash·청크 수가 나온다.
   미존재 지침 → 404
8. PATCH status: `ACTIVE` → `SUPERSEDED` 전환이 반영되고, 그 버전의 청크가 검색에서 빠진다.
   미존재 버전 → 404
9. **DELETE: 인용이 없는 버전 → 204, 그 버전의 청크·섹션·버전 행이 사라진다.** 같은 지침의 다른
   버전은 영향받지 않는다
10. **DELETE: 인용된 청크가 있는 버전 → 409 `GUIDELINE_VERSION_CITED`, 청크·섹션·버전이 하나도
    지워지지 않는다** (부분 삭제 없음)
11. GET /admin/ingestion-runs: 최신순 + 커서 페이지네이션, 실패 실행의 `error`가 함께 보인다

## Out of scope

- **수집·파싱 트리거** — 770MB·수 분짜리 배치는 HTTP 모양이 아니다. §22 스케줄러가 잡으로 수행하고,
  이 API는 그 잡이 만든 결과를 조회·관리한다
- **역할 관리 API** — 누가 누구에게 ADMIN을 주는가. 최초 지정은 수동 `UPDATE`로 하고, 필요해지면 별도 spec
- **관리 화면(FE)** — 이 스텝은 계약까지다
- 문서별·클리닉별 세밀한 권한, 감사 로그 전용 테이블
- 청크 단위 수정 — 청크는 파싱 산출물이라 손으로 고치지 않는다. 고쳐야 하면 파서를 고치고 재적재한다
