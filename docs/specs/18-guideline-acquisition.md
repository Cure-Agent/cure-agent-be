# 18. 지침 원본 수집 (NCKM)

## 목표

국가한의임상정보포털(NCKM)에서 한의표준임상진료지침 목록과 PDF 원본을 수집해, 문서별 출처·해시를
`source_documents`에 기록한다. **수집까지가 이번 범위**이며, PDF 파싱·청킹(→ `GuidelineIngestInput`
생성)은 §19, 개정 감지 스케줄러는 §20의 몫이다.

원본 PDF는 **DB에 저장하지 않는다** — 언제든 재다운로드 가능하고, 재배포 회피 방침(레포엔 임베딩만,
원문은 NCKM 링크)과도 맞다. DB에는 출처·해시만 남겨 변경 감지의 기준으로 쓴다. 이 테이블은
**수집 추적 전용**이며 임베딩을 갖지 않는다 — 벡터는 §5의 `evidence_chunks`에만 존재하고, 그것도
§19에서 실제로 인제스트하기로 선택한 문서에 한한다.

## 범위 (진입점)

엔드포인트 없음 — CLI 배치다.

| 진입점 | 동작 |
|---|---|
| `pnpm acquire:nckm [--limit N] [--guide-idx N,N] [--out DIR]` | 목록 수집 → 각 문서 PDF 다운로드 → `source_documents` 기록 |

- 외부 HTTP는 **`GuidelineSourcePort`(신규 포트)** 뒤에 둔다. e2e는 fake 구현으로 돌아 네트워크에
  의존하지 않으며, 실제 NCKM 호출은 CLI 실행 시에만 일어난다. §3의 포트 기준("감싸지 않으면 수용
  기준을 동결할 수 없는 프로세스 밖 경계")을 만족한다 — 수용 기준 2·3·4·7이 응답 형태를 제어해야
  검증 가능하기 때문이다.
- **판정은 포트가 아니라 서비스가 한다.** 포트는 받아온 것을 그대로 넘기고
  (`{ body: Buffer, contentType: string }`, 네트워크 실패는 예외를 던진다),
  `FETCHED`/`SKIPPED_NO_ATTACHMENT`/`FAILED` 판정과 매직바이트 검사는 서비스의 몫이다 —
  포트가 판정하면 fake도 판정을 흉내내야 해서 **수용 기준 2·3·4가 자기 자신을 검증하게 된다.**
- 다운로드한 PDF는 `--out` 디렉토리(기본 `.cure-data/`, git-ignored)에 쓰고 DB에는 경로를 남기지 않는다.

### NCKM 접속 규약 (실측 확인 — 2026-07-28)

| 항목 | 값 |
|---|---|
| 목록 | `POST /nckm/module/practiceGuide/jqgridStartMain.do` · body `viewPage=1&rowCount=100&gubun=INT&progress=E` → JSON(`rows[]`) · 국내 개발완료 **86건** |
| 상세(원문 링크) | `GET /nckm/module/practiceGuide/view.do?guide_idx=<idx>&menu_idx=14` |
| 다운로드 | `GET /nckm/module/practiceGuide/download.do?guide_idx=<idx>&file_type=pdf` |
| 필수 헤더 | `User-Agent`(브라우저 UA) + `Referer`(해당 문서의 view.do) — **누락 시 WAF가 400 `Request Blocked`** |
| 페이지 크기 | `rows`가 아니라 **`rowCount`** (jqGrid 기본 파라미터가 먹지 않는다) |

- `rows[]`의 `guide_idx·title·agency·release_date·release_year·guide_file·disease_code`를 메타로 쓴다.
- **첨부가 없는 문서는 200 OK로 2,852B `text/html` 에러 페이지를 반환한다** (86건 중 10건, 구판 계열).
  상태코드만으로 성공을 판정하면 HTML을 `.pdf`로 저장하게 된다.
- `HEAD`는 405, `Range`는 미지원(200 + 전체 `content-length`)이라 크기 사전 조회는 불가하다.
- `content-disposition`의 파일명은 EUC-KR로 깨져 오므로, 파일명은 목록의 `guide_file`을 쓴다.
- `release_date`는 `"2024-07"`처럼 **일자가 없다** — 날짜 타입으로 파싱하지 않고 원문 문자열을 보존한다.
- 요청 간 **최소 500ms 간격**을 둔다 (전수 수집 시 총 770MB / 평균 9MB / 최대 90.5MB).

## Entity / 마이그레이션 변경분

신규 enum `source_document_status`: `FETCHED` / `SKIPPED_NO_ATTACHMENT` / `FAILED`
(기존 `ingestion_status`와 별개다).

신규 테이블 `source_documents` (전 테이블 `base-columns`):

| 컬럼 | 비고 |
|---|---|
| `id` | ULID |
| `source_system` | `'NCKM'` |
| `external_id` | `guide_idx` |
| `title` / `publisher` / `release_date` | 목록 메타. `release_date`는 **text**("2024-07") |
| `source_url` | view.do — 인용 시 노출할 원문 링크 |
| `file_hash` | **응답 본문을 받았으면 그 내용이 무엇이든 sha256**(PDF든 HTML 에러 페이지든). 본문 자체를 못 받은 네트워크 실패만 NULL |
| `file_bytes` / `content_type` | **본문을 받은 모든 경우** 기록 (`FETCHED`·`SKIPPED_NO_ATTACHMENT`·매직바이트 `FAILED`) — `file_hash`와 같은 규칙. 본문 자체를 못 받은 실패만 NULL |
| `status` | 위 enum |
| `error` | 실패 사유, 2000자로 절단 (`ingestion_runs`와 동일 관례) |
| `fetched_at` | 마지막 확인 시각 |

- unique: **partial** — `(source_system, external_id, file_hash) WHERE file_hash IS NOT NULL`
  - 해시가 다르면 새 행이 되어 개정 이력이 누적되고, 같은 해시면 새 행 없이 `fetched_at`만 갱신된다.
  - **partial이어야 하는 이유**: Postgres는 NULL을 서로 다른 값으로 취급하므로, 본문 없는 실패 행이
    섞이면 unique가 걸리지 않아 재실행마다 중복이 쌓인다. 반대로 실패 이력은 누적되는 게 맞으므로
    제약 대상에서 빼는 것이 의도된 동작이다.
  - **첨부 없는 문서(HTML)도 본문 해시를 갖는 덕분에 멱등이 성립**하고, 나중에 첨부가 추가되면
    해시가 바뀌어 새 행이 생긴다 — 개정 감지와 정확히 같은 메커니즘이다.
- index: `(source_system, external_id)` — 최신 행 조회용.
- `guideline_versions.content_hash`(파싱된 입력의 해시)와 **계층이 다르다**: 이쪽은 원본 파일의
  해시라, 파일이 그대로면 §19의 파싱 자체를 건너뛰는 판정에 쓴다.
- `.gitignore`에 `.cure-data/` 추가.

## 추가 에러코드

없음 — CLI 전용이라 HTTP 응답 봉투를 타지 않는다. 개별 문서 실패는 `status=FAILED` + `error`로 기록한다.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

1. fake 소스에서 목록 N건 수집 → `source_documents` N행, `guide_idx·title·agency·release_date`가
   각 컬럼에 정확히 매핑된다 (`release_date`는 `"2024-07"` 원문 그대로)
2. `application/pdf` + 매직바이트 `%PDF` 응답 → `status=FETCHED`, `file_hash`가 본문 sha256과 일치,
   `file_bytes` 기록
3. **200 OK + `text/html` 응답 → `SKIPPED_NO_ATTACHMENT`로 기록되고 파일을 쓰지 않으며, 배치는
   다음 문서로 계속 진행한다** (`file_hash`는 그 HTML 본문의 해시로 기록된다)
4. `content-type`은 pdf인데 매직바이트가 `%PDF`가 아니면 → `FAILED` + 사유 기록, 파일 미저장
5. 동일 문서를 같은 내용으로 재수집 → 새 행이 생기지 않고 `fetched_at`만 갱신된다 (멱등).
   **`FETCHED`와 `SKIPPED_NO_ATTACHMENT` 양쪽에서 성립한다**
6. 동일 문서의 내용이 바뀜(해시 상이) → 새 행이 추가되고 이전 행은 보존된다
7. 개별 문서의 네트워크 실패(본문 없음)가 배치 전체를 중단시키지 않는다 — 해당 문서만 `FAILED`
   (`file_hash` NULL), 나머지는 진행. 재실행 시 실패 행은 제약에 걸리지 않고 이력으로 누적된다
8. 모든 다운로드 요청에 `User-Agent`와 **해당 문서의** `Referer`가 포함된다 — **이 항목만 e2e가
   아니라 `NckmGuidelineSource` 단위 테스트**(`jest.spyOn(global, 'fetch')`)로 검증한다. fake는
   포트 구현체를 통째로 대체하므로 실 구현이 만드는 HTTP 헤더를 볼 수 없다
   (`openai-embedding.provider.spec.ts` 기준 1의 `Authorization` 헤더 검증과 같은 패턴).
   같은 테스트에서 목록 요청이 `rowCount` 파라미터를 쓰는지도 함께 검증한다
9. `--guide-idx`로 특정 문서만, `--limit`으로 건수를 제한해 수집할 수 있다

## Out of scope

- **PDF 파싱·청킹** (권고문 단위 분해, 등급 추출, `GuidelineIngestInput` 생성) — §19
- **개정 감지 스케줄러** (크론 + Redis 락) — §20. 수집 유스케이스가 안정된 뒤 그것을 감싸기만 한다
- `source_documents` ↔ `guideline_versions` 연결(추적성 FK) — 파싱이 붙는 §19에서 결정한다
- 원본 PDF의 DB·오브젝트 스토리지 저장 — 재다운로드로 대체 (§목표)
- 국외 지침(`gubun=EXT`, 353건), NCKM 외 출처(대한비만학회 등)
- 수집 결과 조회 API·화면 — 필요해지면 별도 spec
