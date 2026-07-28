# 21. 지침 코퍼스 관리 API

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.**

## 목표

지침 코퍼스를 API로 **적재·조회·폐기·삭제**한다. 지금 파이프라인은 단방향이라 되돌릴 수단이 없다:

- `GuidelineIngestService`는 동일 버전 재인제스트를 **조용히 skip**한다(`created: false`)
- repository에 삭제·수정 메서드가 **없다**
- `guidelines.status`(ACTIVE/SUPERSEDED)는 있으나 **전환 코드가 없고**, 지침 단위라 버전 단위 폐기가 안 된다

§20에서 파서를 고쳤고 171·324는 아직 PARTIAL이다. 파서는 앞으로도 바뀌므로 **재적재는 예외가 아니라
일상**인데, 지금은 DB를 직접 건드리는 것 말고 길이 없다. **코퍼스를 올리기 전에** 되돌릴 수단이 있어야 한다.

문서 **1건**의 수집→파싱→적재까지 이 스텝에서 다룬다. **전건 일괄은 다루지 않는다** — 아래 「1건과 전건의 경계」.

## 범위 (엔드포인트)

전부 **ADMIN 역할** 필요. 관리 화면이 소비할 계약이므로 OpenAPI에 **포함**한다(제외하지 않는다).

| API | Request | Response data | 동작 |
|---|---|---|---|
| POST /admin/guidelines/pipeline | RunPipelineRequestDto | AdminIngestResponseDto | **1건 수집→파싱→적재** |
| POST /admin/guidelines/parse | ParseGuidelineRequestDto | GuidelineIngestInput | **1건 수집→파싱까지** — 적재하지 않고 JSON을 돌려준다 |
| POST /admin/guidelines/ingest | GuidelineIngestInput (§5 계약 그대로) | AdminIngestResponseDto | 파싱된 JSON 적재 |
| GET /admin/guidelines | ListAdminGuidelinesQueryDto | AdminGuidelineSummaryResponseDto[] + page | 지침별 버전 수·활성 revision·청크 수 |
| GET /admin/guidelines/{guidelineId}/versions | – | AdminGuidelineVersionResponseDto[] | 버전 이력 (revision·status·contentHash·청크 수) |
| PATCH /admin/guideline-versions/{versionId} | UpdateVersionStatusRequestDto | AdminGuidelineVersionResponseDto | ACTIVE ↔ SUPERSEDED |
| DELETE /admin/guideline-versions/{versionId} | – | 204 | 버전·섹션·청크 삭제 |
| GET /admin/ingestion-runs | ListIngestionRunsQueryDto | AdminIngestionRunResponseDto[] + page | 인제스트 이력 |

- 목록은 불투명 커서 + PageMeta (§10.4).
- `pipeline`·`parse`는 `guideIdx`(NCKM 문서 식별자)를 받는다. 수집은 §18의 `GuidelineSourcePort`를 그대로 쓴다.

### 파싱과 적재를 합쳐도 되는 이유

§19는 둘을 일부러 분리했다 — *"중간 산출물을 눈으로 검토하는 단계가 인용 정확도의 마지막 방어선"*.
그건 **자동 검증도 없고 되돌릴 수도 없던 시점**의 논리다. 전제가 둘 다 바뀌었다:

| §19 당시 | 지금 |
|---|---|
| 파서가 조용히 0청크를 낼 수 있었다 | **§20 실패 가드** — 마커 수 불일치·등급 누락·중복이면 실패한다 |
| 잘못 적재하면 되돌릴 수 없었다 | **이 스텝의 revision·SUPERSEDED·삭제** |

그래서 `pipeline`을 기본 경로로 둔다. 다만 **검토 경로를 없애지는 않는다** — `parse`가 적재 없이
JSON만 돌려주므로, 보고 싶을 때 보고 `ingest`로 올릴 수 있다. 강제하지 않되 가능하게 남긴다.

### PDF는 디스크에 쓰지 않는다

`pipeline`·`parse`는 받은 PDF를 **메모리에서 파싱하고 버린다.** 실측 크기가 중앙값 5.5MB·최대 90.5MB라
단일 버퍼로 감당되고, 디스크에 쓰면 누적된다 — 현재 수집 경로에는 **삭제 코드가 없어** 그대로 쌓인다.
`source_documents` 기록(해시·상태·`fetched_at`)은 §18 그대로 남긴다. 원본이 필요하면 재다운로드한다(§18 목표).

`extractPdfPages`는 파일 경로만 받으므로 **버퍼를 받는 경로를 추가**한다(내부적으로 이미 `Uint8Array`를 쓴다).

### 1건과 전건의 경계

**1건은 잡이 필요 없고, 전건은 잡 없이는 불가능하다.** 이 선에서 스텝을 자른다.

| 단위 | 소요 | 형태 |
|---|---|---|
| 1건 | 다운로드(중앙값 5.5MB) + 파싱 0.8초 + 임베딩 ~2회 ≈ **10~20초** | 동기 HTTP로 충분 (`nginx` 일반 API `proxy_read_timeout 300s`) |
| 전건 86건 | 스로틀 43초 + 770MB 전송 + 파싱 1~2분 + 임베딩 ~135회 ≈ **수 분** | 잡 + 진행 스트림 필요 → **별도 spec** |

27건 정도는 이 API를 27번 호출하면 된다(스크립트로 감으면 그만이다). 전건 자동화가 실제로 필요해지면
그때 잡을 만든다.

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
| `GUIDELINE_PARSE_FAILED` | 422 | 지침을 파싱하지 못했습니다. |
| `GUIDELINE_SOURCE_UNAVAILABLE` | 502 | 지침 원본을 가져오지 못했습니다. |

- `GUIDELINE_PARSE_FAILED`의 `data`에 §20 가드가 잡은 **문제 권고 번호를 싣는다**(`missing`·`duplicated`·
  `gradeMissing`). 어떤 번호가 왜 걸렸는지 없으면 어디를 고쳐야 하는지 알 수 없다.
- 첨부가 없는 문서(§18 `SKIPPED_NO_ATTACHMENT`)는 에러가 아니다 — 200으로 그 상태를 돌려준다.

나머지는 공통으로 충분하다 — 미인증 `UNAUTHORIZED`(401), 역할 부족 `FORBIDDEN`(403), 미존재 `NOT_FOUND`(404).

## 인증·권한

- `clinicians.role`이 `ADMIN`인 사용자만 `/admin/*`에 접근한다.
- **역할은 access 토큰 페이로드에 넣지 않고 가드가 DB에서 조회한다.** 토큰에 박으면 권한 회수가
  access TTL만큼 지연되고, §4.3의 rotation 설계를 건드리게 된다. 관리 엔드포인트는 트래픽이 없어
  요청당 조회 1회가 무해하다.
- **최초 ADMIN 지정은 수동 `UPDATE`로 한다.** 역할 관리 API는 이번 범위가 아니다(Out of scope).

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

1. 미인증으로 `/admin/*` 접근 → 401 `UNAUTHORIZED`. `MEMBER` 역할로 접근 → **403 `FORBIDDEN`**
   (전 엔드포인트)
2. `ADMIN`으로 POST pipeline → `source_documents`에 수집 기록이 남고, `revision=1` · `status=ACTIVE`로
   적재되며 청크에 임베딩이 존재한다. **PDF 파일이 디스크에 남지 않는다**
3. **파싱 가드에 걸리는 문서로 POST pipeline → 422 `GUIDELINE_PARSE_FAILED`**, `data`에 문제 권고
   번호가 실리고 **적재는 일어나지 않는다**(`guideline_versions` 무변경)
4. POST parse → 적재 없이 `GuidelineIngestInput` JSON을 돌려준다 (`guideline_versions` 무변경)
5. POST ingest에 **동일 입력** 재적재 → 새 revision이 생기지 않고 `created=false`, `ingestion_runs`만
   1건 늘어난다 (§5 수용 기준 2의 멱등성이 깨지지 않는다)
6. **내용이 바뀐 재적재 → `revision=2`가 `ACTIVE`, `revision=1`은 `SUPERSEDED`로 내려가고
   revision 1의 청크는 그대로 남아 있다**
7. 검색은 `ACTIVE` 버전의 청크만 반환한다 — 6의 상태에서 revision 1의 청크는 검색 결과에 없다
8. GET /admin/guidelines: 지침별 버전 수·활성 revision·청크 수가 나오고 커서 페이지네이션이 동작한다
9. GET /admin/guidelines/{id}/versions: revision 내림차순으로 status·contentHash·청크 수가 나온다.
   미존재 지침 → 404
10. PATCH status: `ACTIVE` → `SUPERSEDED` 전환이 반영되고, 그 버전의 청크가 검색에서 빠진다.
    미존재 버전 → 404
11. **DELETE: 인용이 없는 버전 → 204, 그 버전의 청크·섹션·버전 행이 사라진다.** 같은 지침의 다른
    버전은 영향받지 않는다
12. **DELETE: 인용된 청크가 있는 버전 → 409 `GUIDELINE_VERSION_CITED`, 청크·섹션·버전이 하나도
    지워지지 않는다** (부분 삭제 없음)
13. GET /admin/ingestion-runs: 최신순 + 커서 페이지네이션, 실패 실행의 `error`가 함께 보인다

## Out of scope

- **전건 일괄 파이프라인** — 수 분짜리라 잡과 진행 스트림이 필요하다. 잡을 만들면 크론도 그것을
  부르면 되므로 **잡·진행 스트림을 다루는 별도 spec**에서 함께 설계한다
- **개정 감지 스케줄러**(크론 + Redis 락 + 개정 판정) — 위 잡을 감싸는 **별도 spec**
- **역할 관리 API** — 누가 누구에게 ADMIN을 주는가. 최초 지정은 수동 `UPDATE`로 하고, 필요해지면 별도 spec
- **관리 화면(FE)** — 이 스텝은 계약까지다
- 문서별·클리닉별 세밀한 권한, 감사 로그 전용 테이블
- 청크 단위 수정 — 청크는 파싱 산출물이라 손으로 고치지 않는다. 고쳐야 하면 파서를 고치고 재적재한다
