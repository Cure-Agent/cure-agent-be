# 22. 지침 전건 파이프라인 — 잡·진행 스트림·단계별 실행 기록

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.**

## 목표

전건(원본 목록 86건)을 **한 번의 호출로** 수집→파싱→임베딩→적재하고, 진행 상황을 SSE로 지켜본다.
문서별 실행이 **어느 단계에서 무슨 코드로** 끝났는지 남아, 잡이 끝난 뒤에도 원인을 알 수 있다.

§21은 1건 동기 파이프라인까지 다루고 전건을 «수 분짜리라 잡과 진행 스트림이 필요하다»며 미뤘다.
그 잡을 만든다. 파서는 앞으로도 바뀌고 §21이 「재적재는 예외가 아니라 일상」이라고 못 박은 이상
전건 재적재는 반복 작업인데, `pipeline`을 86번 부르는 스크립트로는 **어디까지 갔는지도 무엇이
실패했는지도 남지 않는다.** 171·324가 아직 PARTIAL이라 실패는 예외가 아니라 예상된 결과다.

## 범위 (엔드포인트)

전부 **ADMIN 역할** 필요. §21과 같이 OpenAPI에 포함한다.

| API | Request | Response data | 동작 |
|---|---|---|---|
| POST /admin/guideline-jobs | CreateGuidelineJobRequestDto | GuidelineJobResponseDto | 잡 시작 — **202**, 즉시 반환 |
| GET /admin/guideline-jobs | ListGuidelineJobsQueryDto | GuidelineJobResponseDto[] + page | 잡 이력 — 최신순 커서 (§10.4) |
| GET /admin/guideline-jobs/{jobId} | – | GuidelineJobDetailResponseDto | 잡 + **문서별 실행 전체 중첩** |
| GET /admin/guideline-jobs/{jobId}/stream | – | SSE (봉투 미적용, §8) | 진행 스트림 |
| POST /admin/guideline-jobs/{jobId}/cancel | – | GuidelineJobResponseDto | 취소 요청 |
| GET /admin/pipeline-runs | ListPipelineRunsQueryDto | PipelineRunResponseDto[] + page | **단계별 실행 이력** — 잡 밖 실행 포함 |

- `CreateGuidelineJobRequestDto { externalIds?: string[] }` — 생략하면 원본 목록 전건.
  **실패한 문서만 다시 돌리는 것이 이 필드의 용도다**(아래 「재시작으로 끊긴 잡·실행」).
- **원본 목록에 없는 `externalId`가 섞여 있어도 POST는 거절하지 않는다** — 잡은 202로 뜨고 `total`은
  준 개수 그대로이며, 그 문서는 `FAILED`·`phase=ACQUIRE`·`errorCode=NOT_FOUND` 실행 행으로 남아
  `failed`에 합산되고 잡은 `COMPLETED`가 된다. §21이 세운 「없는 것」과 「못 가져온
  것(`GUIDELINE_SOURCE_UNAVAILABLE`)」의 구분을 잡 경로에서도 유지한다. 대상 문서는 언제나 실행 행을
  하나씩 가지므로 잡이 정상 종료하면 `processed`가 `total`과 같아진다.
- 잡 상세는 실행을 **중첩해 담는다** — §21이 버전 이력을 서브리소스로 쪼개지 않은 것과 같은 판단이다.
  전건이어도 86행이라 페이지네이션이 필요할 만큼 커지지 않는다.
- **정렬**: `GET /admin/pipeline-runs`는 잡 목록과 같이 **최신순**(`id` ULID 내림차순)이며 어떤 필터를
  걸어도 정렬 축은 바뀌지 않는다. 반면 잡 상세와 `job.snapshot`에 중첩되는 `runs`만 **`order`
  오름차순**이다 — 스냅샷 뒤에 이어지는 `run.stage`가 같은 진행 순서라, 클라이언트가 스냅샷 배열에
  이벤트를 그대로 이어붙일 수 있어야 한다.
- `POST`는 SSE를 제외한 일반 JSON API와 같이 **공통 봉투를 적용**하고(§10.1의 봉투 미적용은 SSE·파일
  다운로드뿐) `@HttpCode(202)` + 기본 성공코드 `SUCCESS`로 응답한다 — 202용 `ACCEPTED`를 성공코드
  레지스트리에 신설하지 않는다(§21 `POST /admin/guidelines/pipeline`과 같은 선택). **`Location` 헤더는
  두지 않는다** — `jobId`는 `data`로만 전달하고 상세·스트림 경로는 클라이언트가 조립한다.
- **POST는 원본 목록을 조회하지 않는다.** 잡 행을 `status=RUNNING` · 카운터 전부 0(`total` 포함)으로
  만들어 **그대로** 반환하므로, 잡이 아무리 빨리 끝나도 POST 응답의 status는 항상 `RUNNING`이다.
  `total`은 러너가 원본 목록을 받은 직후 채운다 — 수용 기준 2·10의 `total` 단언은 POST 응답이 아니라
  **잡 종료 후 조회(또는 스냅샷 이후의 스트림 이벤트)**에서 성립한다.
- `pipeline-runs`는 `jobId`·`externalId`·`status`·`phase` 필터를 받는다. 잡에 속하지 않은 실행
  (§21의 1건 동기 호출, §05 JSON 인제스트 스크립트)까지 한 자리에서 보는 것이 이 목록의 존재 이유다.
- SSE는 GET이라 `EventSource`가 쿠키를 실어 보내고 CSRF 가드(§4.1)의 안전 메서드를 통과한다.

### 잡은 인프로세스로 돈다 — 큐를 들이지 않는다

배포는 단일 서버·단일 컨테이너다(`docker/gcp/compose.yml`). 전건 잡은 NCKM에 **순차** 요청하므로
(스로틀 `NCKM_REQUEST_INTERVAL_MS`) 워커 풀이 쓰일 자리가 없고, 동시에 도는 잡도 1개다.
BullMQ 같은 큐는 이 형태에서 얻는 것이 없다 — **의존성 하나와 운영 대상 하나가 늘 뿐이다.**

상태는 **DB에 쓴다.** Redis는 「가용성 필수 의존성이 아니다」라는 전제로 fail-open하게 붙어 있고
(§4.3 denylist, `redis.module.ts`의 `enableOfflineQueue=false`), 잡 이력은 잃으면 안 된다.

### SSE는 스냅샷으로 복구한다 — seq를 두지 않는다

§8의 대화 스트림은 델타가 **누적되어야 완성되는 텍스트**라 순서·중복 감지에 `seq`가 필요했다.
잡 진행은 반대로 **그 자체가 누적 상태**다 — 다시 연결해 현재 카운트를 받으면 복구가 끝난다.
`Last-Event-ID` 재생 버퍼를 두지 않는다.

- 첫 이벤트는 항상 `job.snapshot`이고 **그때까지의 실행을 전부 싣는다**. 재연결과 최초 연결이 같은
  경로를 쓴다.
- **이미 끝난 잡의 스트림을 열면** 스냅샷 + 종결 이벤트를 즉시 보내고 닫는다 — 폴링 없이 결과를
  확인하는 경로가 된다. 「연결이 늦어 종결 이벤트를 놓쳤다」가 성립하지 않는다.
- fan-out은 인프로세스 EventEmitter다. Redis pub/sub은 인스턴스가 여럿일 때 필요한데 지금은 하나다.
- 잡은 **스트림과 무관하게 끝까지 돈다.** 구독자가 0이어도, 보던 관리자가 창을 닫아도 계속한다 —
  §8-4의 abort→CANCELLED 규약은 요청이 곧 작업인 대화 스트림의 것이고, 여기서는 반대다.

이벤트 계약은 architecture.md §8에 `GuidelineJobStreamEventDto`로 추가한다:

```ts
type GuidelineJobStreamEventDto =
  | { eventType: "job.snapshot"; job: GuidelineJobResponseDto; runs: PipelineRunResponseDto[] }
  | { eventType: "run.stage";     job: GuidelineJobResponseDto; run: PipelineRunResponseDto }
  | { eventType: "job.completed"; job: GuidelineJobResponseDto }
  | { eventType: "error"; code: string; message: string; retryable: boolean; traceId: string };
```

`job.completed`가 **유일한 정상 종결**이다 — 취소·중단·전건 실패도 여기로 오고 `job.status`로
구분한다. 종결을 이벤트 타입으로 쪼개면 소비자가 「어떤 이벤트가 끝인가」를 상태 수만큼 알아야 한다.

### 스트림은 문서가 아니라 단계 단위다

`run.stage`는 **단계에 진입할 때마다** 나간다 — 문서당 5개(ACQUIRE→PARSE→EMBED→INGEST 진입,
그리고 종결). 문서가 끝날 때 하나만 보내면 **4단계를 나눈 이유가 실시간에는 사라지고**, 가장 느린
구간인 다운로드(중앙값 5.5MB·최대 90.5MB)가 통째로 침묵이 된다.

payload는 **run 전문**이다 — `phase`가 지금 어디인지, `stages`에 여기까지의 산출이 누적돼 있다.
그래서 스트림과 `GET /admin/pipeline-runs`가 **같은 `PipelineRunResponseDto`를 공유한다**:
둘은 대체재가 아니라 시간 축이 다른 같은 데이터다(스트림은 지금, 목록은 그동안).

**모든 이벤트가 `job`을 함께 싣는다.** 진행률 카운터가 항상 최신이라 클라이언트가 이벤트를 누적할
필요가 없다 — 위의 「스냅샷으로 복구한다, seq를 두지 않는다」와 같은 방향이다.

### 개별 문서의 실패는 잡을 멈추지 않는다

§18 배치와 같은 규칙이다. 전건에서 가장 흔한 실패는 파싱이고(§20 가드), 한 건 때문에 나머지 85건이
안 들어가면 잡을 쓸 이유가 없다.

- 잡은 전건 시도를 마치면 **성공·실패가 섞여 있어도 `COMPLETED`**다. 「전부 성공」은 요약 카운트가 말한다.
- `FAILED`는 **러너 자체가 죽어 남은 문서를 시도하지 못한** 경우다(원본 목록 조회 실패·DB 장애).

### 재적재 의미론은 §21 그대로다

전건 잡은 매번 **전부 다시 받아 전부 다시 파싱한다.** PDF가 그대로여도 파서가 바뀌면 결과가
달라지므로 **수집 해시로 파싱을 건너뛰지 않는다.** 내용이 같으면 §21의 `contentHash` 판정이
`created=false`로 흡수하고 달라진 문서만 `revision+1`이 된다 — **파서를 고치고 전건을 한 번
돌리는 것**이 그대로 §21의 재적재 루프가 된다.

PDF도 §21과 같이 디스크에 쓰지 않는다. 770MB를 한꺼번에 들지 않고 **문서 하나를 파싱한 뒤 버린다** —
최대 90.5MB 단일 버퍼가 상한이다.

## Entity / 마이그레이션 변경분

### `ingestion_runs`를 `pipeline_runs`로 승격한다 — 4단계를 모두 기록

지금은 **파싱과 임베딩에 기록이 없다.** 다운로드는 `source_documents`에 남지만 그것은 문서의 현재
상태지 실행 이력이 아니고(같은 해시면 행을 만들지 않는다), `ingestion_runs`만 실행 단위 기록을 갖는다.
그래서 파싱 실패는 예외로 던져지고 사라지며, **임베딩 실패는 「적재 실패」로 뭉개진다** —
`EmbeddingProviderError`라는 구분 가능한 예외가 이미 있는데도(`embedding-provider.port.ts`)
파서를 고쳐야 하는 실패와 잠시 후 재시도하면 되는 실패가 같은 모양으로 보인다.

**이 테이블을 4단계 실행 기록으로 승격하고, 잡의 문서별 결과도 이것을 쓴다.**

```
guideline_jobs (1) ──< pipeline_runs (N)
                          ▲
                          └── job_id = NULL  →  잡 밖의 실행 (§21 1건 동기, §05 스크립트)
```

잡 전용 항목 테이블을 따로 두면 **같은 사건이 두 곳에 기록된다.** 1건 동기 경로와 전건 잡이 같은
기록 구조를 쓰면 관리자가 「어느 쪽을 봐야 하나」를 판단할 일이 없고, §21이 이 스펙에 넘긴
「인제스트 이력 조회」가 그대로 이 목록으로 이행된다.

**rename이 아니라 신규 테이블 + 2단계 배포다.** 테이블 개명은 `automation/pipeline.md`의 파괴적
마이그레이션에 해당한다 — 앱 이미지가 롤백되면 스키마는 되돌아가지 않아 구버전 앱이 사라진
테이블을 참조한다. 이 스텝은 **1차만** 수행한다:

| 단계 | 내용 |
|---|---|
| **1차 (이 스텝)** | `CREATE TABLE pipeline_runs` + 앱이 그것만 쓰도록 전환. `ingestion_runs`는 **남겨두되 더 이상 쓰지 않는다** |
| **2차 (별도 배포)** | 1차 안정 확인 후 `DROP TABLE ingestion_runs` |

코퍼스가 비어 있어(§21) **기존 행을 옮기지 않는다** — 빈 코퍼스의 실행 로그라 보존 가치가 없다.

- 신규 enum `pipeline_run_status`: `RUNNING` / `SUCCEEDED` / `SKIPPED` / `FAILED` / `INTERRUPTED`
- 신규 enum `pipeline_run_phase`: `ACQUIRE` / `PARSE` / `EMBED` / `INGEST`
- 컬럼: id, jobId(nullable → `guideline_jobs.id`), order, sourceSystem, externalId(둘 다 nullable —
  §05 JSON 인제스트에는 원본 식별자가 없다), status, phase, errorCode, error, inputHash,
  guidelineId, guidelineVersionId, revision, created, stages(jsonb), startedAt, finishedAt
- 인덱스: `(jobId, order)`, `(externalId)`, `(status)`

```
stages = {
  acquire: { bytes, contentType, ms },
  parse:   { pages, sections, chunks, ms },
  embed:   { vectors, model, ms },
  ingest:  { sections, chunks, skippedChunks, ms }
}
```

각 키는 그 단계가 **실제로 낸 산출**이다 — `acquire.bytes`·`contentType`은 받은 본문 기준(§18은 첨부가
없어도 본문을 받았으면 기록한다), `parse.{pages,sections,chunks}`는 파서 출력 그대로(**dedupe 전** 청크
수), `embed.vectors`는 임베딩을 **실제로 호출한** 청크 수(dedupe 후 = `ingest.chunks`),
`ingest.{sections,chunks,skippedChunks}`는 기존 `stats` 정의 그대로다(재적재 skip이면 `{0, 0, 전체 청크 수}`).

**키는 그 단계를 마쳤을 때만 생긴다** — 도달하지 못했거나 실패한 단계의 키는 0으로 채우지 않고 아예
없다. `SKIPPED` 실행은 `{acquire}`, EMBED 실패는 `{acquire, parse}`, `created=false` 실행은 임베딩을
호출하지 않으므로 `embed` 없이 `{acquire, parse, ingest}`다.

**단계 세부는 jsonb 하나로 둔다.** 단계마다 필드가 이질적이라 컬럼으로 펴면 대부분 null인 16개
컬럼이 된다. 자주 필터에 거는 축(`status`·`phase`·`errorCode`·`externalId`·`jobId`)만 컬럼으로
뺀다 — 기존 `stats` jsonb가 이미 쓰던 관례다.

**run 행은 문서를 시작할 때 만들고 단계마다 갱신한다** — 끝날 때 한 번 쓰지 않는다.
끝날 때 쓰면 **처리 도중 죽은 그 문서만 기록이 없다.** 「어디까지 갔는지는 `pipeline_runs`에
남는다」가 성립하려면 진행 중인 행이 있어야 한다. 문서당 insert 1 + update 4로 86건이면 430회,
Postgres에는 아무것도 아니다. 이 증분 저장이 곧 `run.stage` 이벤트의 원천이기도 하다.

**실행 상태의 의미**(§18·§21의 기존 어휘를 그대로 쓴다):

| status | 뜻 | phase |
|---|---|---|
| `RUNNING` | 진행 중 | 지금 처리 중인 단계 |
| `SUCCEEDED` | 끝까지 갔다. 새 revision이면 `created=true`, 내용이 같아 skip이면 `created=false` | `INGEST` |
| `SKIPPED` | 첨부가 없어(§18 `SKIPPED_NO_ATTACHMENT`) 파이프라인에 들어가지 못했다 — **에러가 아니다**(§21) | `ACQUIRE` |
| `FAILED` | 실패했다 — `errorCode`에 §21의 코드를 그대로 기록한다 | 실패한 단계 |
| `INTERRUPTED` | 처리 도중 프로세스가 죽었다 (아래 「부팅 시 정리」) | 죽은 단계 |

`phase`는 그 실행이 **가장 멀리 도달한 단계**다. 진행·성공·실패·건너뜀·중단을 같은 축으로 읽을 수 있다.

### 신규 테이블 `guideline_jobs`

- 신규 enum `guideline_job_status`: `RUNNING` / `COMPLETED` / `CANCELLING` / `CANCELLED` / `INTERRUPTED` / `FAILED`
- 컬럼: id, status, requestedBy(→`clinicians.id`), total, processed, succeeded, skipped, failed, startedAt, finishedAt, error
- **카운터 산식**: `succeeded`·`skipped`·`failed`는 그 잡에 속한 `pipeline_runs`의 종결 상태를 그대로
  집계한 값이고(§21 재적재로 `created=false`인 실행도 `succeeded`다), `processed = succeeded +
  skipped + failed`라 진행 중(`RUNNING`)인 실행은 세지 않으며 `INTERRUPTED`는 어느 카운터에도 들어가지
  않는다. `total`은 잡 시작 시점에 정해져 도중에 변하지 않으므로, 취소·중단으로 시도하지 못한 문서가
  있으면 `processed < total`로 끝난다.
- **동시 실행 1개 강제**: partial unique index — `WHERE status IN ('RUNNING','CANCELLING')`

`PENDING`을 두지 않는다 — 큐가 없어 생성 즉시 시작하므로 대기 상태가 존재하지 않는다.
동시 실행은 앱 메모리 플래그가 아니라 **DB 제약으로 막는다** — 재시작·중복 요청 어느 쪽에서도 같은
규칙이 성립하고, 나중에 크론이 잡을 부를 때도 그대로 유효하다.

### 재시작으로 끊긴 잡·실행 — 부팅 시 정리한다

배포가 잡 도중에 컨테이너를 내리면 그 행은 영원히 `RUNNING`이고, partial unique index 때문에
**다음 잡도 시작할 수 없다.** 부팅 시 `RUNNING`·`CANCELLING` **잡**과 `RUNNING` **실행**을 모두
`INTERRUPTED`로 내린다 — 단일 인스턴스라 부팅 시점에 살아 있는 잡은 정의상 없다.

실행까지 정리하는 덕에 **죽는 순간 처리 중이던 문서가 `phase`와 함께 남는다**(`324 / EMBED /
INTERRUPTED`). 남은 문서는 `externalIds`로 다시 부른다.
**자동 재개는 두지 않는다** — 중단 지점의 문서가 왜 그때 멈췄는지 모르는 채 이어 도는 것보다,
무엇이 남았는지 보고 다시 부르는 편이 안전하고 코드도 없다.

### 취소는 문서 경계에서 멈춘다

`cancel`은 `CANCELLING`으로 표시만 하고 현재 상태를 돌려준다. 러너는 **현재 문서를 마친 뒤** 루프를
빠져나오며 `CANCELLED`가 된다. 다운로드·파싱 중간에 끊으면 부분 적재를 만들 수 있고, 1건은
10~20초(§21)라 기다릴 만하다.

러너는 **첫 문서를 포함해 매 문서를 시작하기 직전에** 잡 상태를 다시 읽어, `CANCELLING`이면 그 문서의
`pipeline_runs` 행을 만들지 않고 루프를 빠져나온다 — 수용 기준 9의 「남은 문서」는 이 검사 시점에 아직
시작하지 않아 실행 행이 없는 문서를 뜻한다. 목록 조회 중이나 첫 문서 시작 전에 취소가 들어오면
**실행 행 0건 · `processed=0`인 `CANCELLED` 잡**이 정상 결과이고, 진행 중이던 문서는 언제나 끝까지 마친다.

이미 `CANCELLING`인 잡에 `cancel`을 다시 호출하면 **200 + 현재 상태**다 — 취소는 표시만 하는 멱등
연산이고, 여기서 「실행 중」은 partial unique index·부팅 시 정리가 쓰는 것과 같은
`status IN ('RUNNING','CANCELLING')`을 뜻한다. 409 `GUIDELINE_JOB_NOT_RUNNING`은 종결
상태(`COMPLETED`·`CANCELLED`·`INTERRUPTED`·`FAILED`)의 잡에만 적용된다.

### 메트릭 — 「느려졌나」는 DB로 답할 수 없다

`pipeline_runs`는 «무엇이 왜 실패했나»에 답하지만 추이는 답하지 못한다. 단계별 소요·실패율을 DB에
쌓기 시작하면 테이블이 시계열 DB 흉내를 내므로, 그쪽은 이미 떠 있는 Prometheus·Grafana(§14,
`docker/gcp/monitoring/`)로 보낸다. `MetricsService`에 두 개만 추가한다:

```
guideline_pipeline_stage_duration_seconds{stage}      # Histogram
guideline_pipeline_stage_total{stage,status}          # Counter
```

라벨 값은 소문자로 고정한다 — `stage`는 `stages` jsonb 키와 같은 `acquire`·`parse`·`embed`·`ingest`이고,
`status`는 실행 status enum이 아니라 **그 단계 자체의 결말**인 `success`·`failure`·`skipped`다
(`MetricsService`의 `LlmOutcome`·`SseOutcome`과 같은 관례). 둘 다 단계가 끝날 때 1회만 기록하므로
`RUNNING`·`INTERRUPTED`에 대응하는 라벨 값은 없다.

## 추가 에러코드

| 코드 | status | message |
|---|---|---|
| `GUIDELINE_JOB_ALREADY_RUNNING` | 409 | 이미 실행 중인 지침 잡이 있습니다. |
| `GUIDELINE_JOB_NOT_RUNNING` | 409 | 실행 중이 아닌 잡은 취소할 수 없습니다. |
| `GUIDELINE_EMBEDDING_FAILED` | 502 | 지침 임베딩에 실패했습니다. |

`GUIDELINE_EMBEDDING_FAILED`는 **상류 실패라 502다**(§10.1 — 502는 우리가 호출한 외부 시스템이
응답하지 않은 경우). 지금은 임베딩 실패가 `INTERNAL_ERROR`(500)로 흘러 우리 코드의 결함과 구분되지
않는다. 나머지는 공통으로 충분하다 — 미인증 401, 역할 부족 403, 미존재 잡 404.

**문서별 실패는 에러 응답이 아니라 실행 행이다**: 위 코드와 §21의
`GUIDELINE_SOURCE_UNAVAILABLE`·`GUIDELINE_PARSE_FAILED`를 `pipeline_runs.errorCode`에 기록한다.
같은 실패를 잡 문맥에서는 데이터로, 1건 동기 호출에서는 HTTP 상태로 표현하는 것이 각 계약에 맞다.

**`errorCode`는 던져진 예외의 타입이 아니라 실패한 단계로 정한다.** 러너가 각 단계의 외부 호출을 감싸
ACQUIRE→`GUIDELINE_SOURCE_UNAVAILABLE`, PARSE(PDF 텍스트 추출 포함 — `stages.parse.pages`가 그
산출이다)→`GUIDELINE_PARSE_FAILED`, EMBED→`GUIDELINE_EMBEDDING_FAILED`로 매핑하며, 임베딩 프로바이더가
`EmbeddingProviderError`가 아닌 평범한 `Error`를 던져도 결과는 같다 — §18 수집이 `GuidelineSourceError`
타입을 보지 않고 다운로드 실패를 전부 `FAILED`로 기록하는 것과 같은 규칙이다. 그 밖의 실패(INGEST 단계
실패, 각 단계의 외부 호출 밖에서 터진 우리 코드 결함)는 `ServiceException`이면 그 코드를, 아니면
`INTERNAL_ERROR`를 기록하고 `phase`는 죽은 단계를 그대로 남긴다. §21의 1건 동기 경로는 그 코드에
대응하는 상태코드를 돌려준다.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

1. 미인증으로 `/admin/guideline-jobs/*`·`/admin/pipeline-runs` 접근 → 401 `UNAUTHORIZED`,
   `MEMBER` 역할 → 403 `FORBIDDEN` (**SSE 엔드포인트 포함** 전 엔드포인트)
2. `ADMIN`으로 POST → **202 + jobId가 즉시** 반환된다. 잡이 끝난 뒤 GET `{jobId}`가 `COMPLETED`이고
   `total`이 원본 목록 건수와 같으며 실행마다 `externalId`·`status`·`phase`·`stages`가 있다
3. **적재까지 실제로 된다** — 성공 실행의 `guidelineVersionId`로 조회하면 `revision=1`·`ACTIVE`이고
   청크에 임베딩이 있다. **PDF 파일이 디스크에 남지 않는다**
4. **개별 문서 실패가 잡을 멈추지 않는다** — 3건 중 1건이 §20 파싱 가드에 걸리면 그 실행만 `FAILED` ·
   `phase=PARSE` · `errorCode=GUIDELINE_PARSE_FAILED`이고, **나머지 2건은 정상 적재**되며 잡은
   `COMPLETED`(succeeded=2, failed=1)
5. **임베딩 실패가 파싱 실패와 구분된다** — 임베딩 fake가 던지면 그 실행이 `phase=EMBED` ·
   `errorCode=GUIDELINE_EMBEDDING_FAILED`이고 `stages.parse`는 채워져 있다.
   같은 상황에서 §21의 1건 동기 `pipeline` 호출은 **502**를 돌려준다
6. **SSE는 단계 단위다**: 첫 이벤트가 `job.snapshot`, 이후 문서마다 `run.stage`가 **`phase`가
   `ACQUIRE`→`PARSE`→`EMBED`→`INGEST` 순으로 오르며 여러 번** 나가고, `stages`가 단계마다 누적된다.
   **모든 이벤트에 `job` 카운터가 실린다.** 마지막이 `job.completed`이며 이후 스트림이 닫힌다
7. **이미 끝난 잡의 스트림**을 열면 `job.snapshot`(그때까지의 `runs` 전부 포함) + `job.completed`를
   즉시 받고 닫힌다. **진행 중인 잡에 늦게 연결해도** 스냅샷의 `runs`로 놓친 구간이 복구된다
8. 실행 중 잡이 있는 상태에서 POST → **409 `GUIDELINE_JOB_ALREADY_RUNNING`**, 새 잡 행이 생기지 않는다
9. cancel → 잡이 `CANCELLED`로 끝나고 **남은 문서의 `pipeline_runs` 행이 생기지 않는다**.
   끝난 잡에 cancel → 409 `GUIDELINE_JOB_NOT_RUNNING`
10. `externalIds`를 주면 **그 문서만** 처리된다(`total` = 준 개수)
11. **재시작 정리**: `RUNNING` 잡 행과 `RUNNING` 실행 행이 남은 상태에서 앱을 기동하면 **둘 다**
    `INTERRUPTED`가 되고, 실행 행은 **죽은 시점의 `phase`를 그대로 유지**하며, 새 잡을 시작할 수 있다
12. **멱등**: 같은 대상으로 잡을 두 번 돌리면 두 번째 실행은 `SUCCEEDED`이되 **`created=false`**이고
    `guideline_versions`의 `revision`이 오르지 않는다 (§21 재적재 의미론이 잡 경로에서도 성립)
13. **GET /admin/pipeline-runs**: §21의 **1건 동기 `pipeline` 호출도 `jobId=null` 실행으로 조회된다**.
    `jobId`·`externalId`·`status`·`phase` 필터와 커서 페이지네이션이 동작한다
14. GET 잡 목록: 잡 이력이 **최신순**으로 나오고 커서 페이지네이션이 동작한다

## Out of scope

- **개정 감지 스케줄러**(크론 + Redis 락 + 개정 판정) — 이 잡을 **부르는 쪽**이다. 잡이 생겼으니
  그 위에 얹으면 된다. 별도 spec
- **자동 재개** — 위 「재시작으로 끊긴 잡·실행」. `externalIds`로 다시 부른다
- **잡 병렬 실행·워커 풀** — 순차 스로틀은 상대 서버에 대한 예의이자 상한이다
- **`source_documents` 조회 API** — 수집 상태는 `pipeline_runs.stages.acquire`로 실행 문맥에서 보인다.
  문서의 현재 상태를 따로 훑을 일이 생기면 그때 만든다
- **`DROP TABLE ingestion_runs`** — 위 2단계 배포의 2차. 1차 안정 확인 후 별도 배포
- **잡 결과 알림**(Discord/Slack) — §14 실시간 알림은 장애용이고, 이 잡은 사람이 시작해 스트림으로
  지켜본다. 크론이 잡을 부르기 시작하면(지켜보는 사람이 없어지면) 그때 필요해진다
- **관리 화면(FE)** — 이 스텝은 계약까지다
- 잡 취소의 즉시 중단(다운로드·파싱 중간 abort) — 위 「취소는 문서 경계에서 멈춘다」
- 단계별 재시도(임베딩 429 백오프 등) — 실패를 **구분해 기록**하는 것이 이 스텝이고, 그 기록을 보고
  재시도 정책을 정하는 것이 다음이다
