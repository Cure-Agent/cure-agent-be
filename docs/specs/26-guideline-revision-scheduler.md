# 26. 지침 개정 감지 스케줄러 — 크론·Redis 락·개정 판정·잡 결과 통보

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.**

## 목표

§18부터 네 번 미뤄온 예약을 실행한다. §22가 전건 잡을 만들며 *"이 잡을 **부르는 쪽**이다. 잡이
생겼으니 그 위에 얹으면 된다"*고 남긴 자리이고, architecture.md §3의
`infrastructure/scheduler/`가 비워둔 자리다.

**사람이 기억해서 눌러야만 원문 개정이 반영되는 상태를 끝낸다.** 708(근골격계 초음파 유도)은
2026-07-29에 목록에 올라왔고, 우연히 07-31에 사람이 전건을 돌려 적재됐다 — 그 클릭이 없었으면
지금도 코퍼스에 없다. 동시에 §22·§25가 미뤄둔 **잡 결과 통보**를 함께 세운다: 지켜보는 사람이
없어지는 순간 SSE 스트림은 아무에게도 도달하지 않으므로, 자동 실행과 통보는 한 스텝이어야 한다.

## 실측 조사 (2026-07-31, NCKM 목록 87건 전수)

| 확인 항목 | 실측 |
|---|---|
| **개정 감지 축** | 목록 응답 행에 **`modify_date`·`add_date`가 있다** — `"Jul 30, 2026 10:05:00 AM"` 형식. 행의 키는 63개인데 `NckmRow`가 5개만 좁혀 받아 지금까지 보이지 않았다. 다운로드 없이 목록 POST 1회로 얻는다 |
| 목록 건수 | **87건**. 2026-07-28 스냅샷(`.cure-data/nckm-list-sizes.json`) 86건 대비 **708 신규** (`add_date` 2026-07-29, `release_date` 2026-08) |
| 하루 1회 크론 모사 | 최근 12개월 중 **잡이 도는 날은 6일**: 2025-08-05(161) · 2026-04-08(163) · 2026-04-16(668) · 2026-07-15(230·231) · 2026-07-21(**306·307·309·311·342·350**) · 2026-07-30(708). 나머지 359일은 목록 POST 1회로 끝난다 |
| **`modify_date` ≠ 파일 교체** | 306은 `modify_date`가 2026-07-21인데 **원격 sha256이 §25 커밋값·로컬 표본과 완전 일치**한다 (`46af0404…8716d`, 12,349,939B). 309도 일치(`f4ff1441…d40f`, 10,788,927B). 레코드만 수정돼도 값이 오른다 |
| 다운로드 없는 확정 불가 | `HEAD` **405**, `Range: bytes=0-1023`은 **무시**(200 + 전체 12.3MB), `last-modified`·`etag` **없음** — §18 실측 재확인. 파일이 실제로 바뀌었는지는 **받아서 해시해야만** 안다 |
| 잡 주체 | `guideline_jobs.requested_by`가 **NOT NULL + `clinicians.id` FK** — 크론에는 대응하는 의료인이 없다 |
| 크론 의존성 | `@nestjs/schedule` **미설치**(최신 6.1.3). `ioredis`는 있다 |
| 알림 배선 | `ObservabilityModule`은 `@Global`이고 `RealTimeAlertSender`를 export — **주입에 모듈 배선 변경 불요**(§25 실측 그대로) |
| 배포 형태 | `docker/gcp/compose.yml` **단일 컨테이너**, `TZ` 미설정 → 프로세스는 **UTC** |

### 판정은 두 층이다 — 목록이 후보를 좁히고, 해시가 개정을 확정한다

위 두 실측(`modify_date`가 파일 교체와 무관하게 오른다 / 파일 변화는 받아야만 안다)이 설계를
강제한다. **매일 770MB를 받아 해시를 비교하는 길은 없다** — 상대 서버에 대한 예의(§18 스로틀)
이전에 11분짜리 전건을 매일 도는 일이다. 그래서:

1. **후보 산출(싸다)**: 목록의 `modify_date`가 마지막으로 받아본 값과 다르거나, 받아본 적이
   없는 문서를 후보로 뽑는다. 목록 POST 1회.
2. **개정 확정(비싸다, 후보에만)**: 후보를 `externalIds`로 §22 잡에 넘긴다. **새 판정 코드가
   없다** — 잡이 다운로드하며 §18의 partial unique가 해시로 새 행을 만들고, 내용이 같으면 §21의
   `contentHash`가 `created=false`로 흡수한다.

**`modify_date`는 상위집합이라 헛도는 잡이 나온다** — 2026-07-21의 6건이 파일 교체 없이
레코드만 수정된 것이라면 잡은 6건을 받아 파싱하고 `created=false`로 끝난다. **그 방향의 오차가
옳다**: false positive는 몇 분의 낭비지만, false negative는 코퍼스가 조용히 낡는 것이다.
임베딩은 `contentHash` 판정에 막혀 호출되지 않으므로 비용도 다운로드·파싱뿐이다.

### baseline은 크론이 아니라 수집 경로가 올린다

`modify_date`의 기록 시점을 **본문을 실제로 받은 순간**으로 못 박는다(§18의 `file_hash` 규칙과
같은 축 — 본문을 받았으면 기록하고, 못 받았으면 NULL). 크론이 후보를 뽑자마자 올리면 그
다운로드가 실패해도 baseline이 올라 **그 개정을 영원히 놓친다.**

이 규칙이 재시도를 공짜로 만든다 — 네트워크 실패로 본문을 못 받은 문서는 baseline이 그대로라
다음 틱에 다시 후보가 된다. 반대로 **다운로드는 됐고 파싱이 실패한 문서는 baseline이 오른다**:
파싱 실패는 사람이 파서나 목록을 고쳐야 낫는 것이라(§24·§25) 매일 다시 도는 것은 소음이고,
그 실패는 이미 잡 결과 알림으로 사람에게 갔다.

### 락은 fail-**closed**다 — Redis 규약의 예외이고, 그래서 옳다

`redis.module.ts`는 *"가용성 필수 의존성이 아니다"*라는 전제로 `enableOfflineQueue=false` +
소비자 fail-open이다(§4.3). **스케줄러는 반대로 간다**: 락을 얻지 못하면(경합이든 Redis
장애든) 그 틱은 아무것도 하지 않는다.

방향이 갈리는 이유가 명확하다. denylist가 fail-close면 Redis 장애가 **로그인 전체를 막아**
서비스가 죽지만, 스캔을 한 틱 거르면 **24시간 뒤에 다시 온다** — 잃는 것이 없다. 크론에서
fail-open은 「락 없이 실행」이고, 그것은 락을 두지 않은 것과 같다.

락은 **스캔 구간만** 감싼다(목록 조회 → 후보 산출 → 잡 생성). 잡 자체는 §22의 partial unique
index가 이미 「전체에서 활성 1개」를 강제하므로 락을 11분간 붙들 이유가 없고, 붙들면 그 사이
프로세스가 죽었을 때 TTL이 지나기 전까지 스케줄러가 통째로 멈춘다. TTL은 그 구간(목록 POST
1회 + INSERT)에 맞춘 짧은 값이며 **잡 소요와 무관하다** — 잡은 락이 풀린 뒤에도 계속 돈다.

## 범위 (진입점)

**신규 엔드포인트는 없다. 다만 잡 응답 스키마가 바뀐다** — 아래 `requested_by` nullable 완화가
`GuidelineJobResponseDto`로 새어 나오기 때문이다(2026-07-31 구현 Phase 1에서 발견, 초안의
「API 계약 무변경」은 틀렸다). `requestedBy`는 지금 OpenAPI에서 `required` + non-nullable이라,
nullable로 바꾸면 `oasdiff breaking`이 잡을 수 있다.

- **`triggeredBy`를 응답에 함께 싣는다** — nullable이 된 필드의 의미를 짝 필드가 설명해야 한다.
  「사람이 지운 잡인가 크론이 만든 잡인가」를 관리자가 응답만으로 구분하지 못하면, `requestedBy:
  null`은 결측과 구분되지 않는다. 필드 **추가**는 breaking이 아니다.
- FE는 이 필드를 쓰지 않아(`cure-agent-fe/src`에 `requestedBy` 0건, §22가 관리 화면을 Out of
  scope로 둔 결과) **실질 파장은 0이다.** `openapi-breaking`이 ERR로 잡으면
  `breaking-change-approved` 라벨로 통과시킨다 — 소비자가 없는 필드의 nullable 확장이다.

| 진입점 | 변경 |
|---|---|
| `infrastructure/scheduler/` (신규) | `@Cron` 트리거만 담는다 — architecture.md §3이 비워둔 자리 |
| `domain/guideline/service/guideline-revision-scan.service.ts` (신규) | 후보 산출 → 잡 위임 → 통보. **크론과 분리한다** |
| `global/redis/redis-lock.ts` (신규) | `SET NX PX` 기반 TTL 락. denylist와 같은 층 |
| `source-document.schema.ts` · repository | `source_modified_at` 컬럼 + 「본문을 받은 최신 행」 조회 |
| `guideline-acquisition.service.ts` | 본문을 받은 경로에서 `sourceModifiedAt` 기록 (insert·touch 양쪽) |
| `nckm.source.ts` · `guideline-source.port.ts` | `SourceListItem`에 `sourceModifiedAt` 추가 (`modify_date` ?? `add_date`) |
| `guideline-job.schema.ts` · service · runner | `triggeredBy` + `requestedBy` nullable, 잡 종결 시 통보 |
| `app.module.ts` | `ScheduleModule.forRoot()` 등록 |
| `package.json` · compose · `.env.example` | `@nestjs/schedule` 추가, 크론 env |

- **크론 트리거를 포트로 감싸지 않는다.** §3의 기준(*"감싸지 않으면 수용 기준을 동결할 수
  없는가"*)은 여기서 **분리**로 충족된다 — e2e가 `scan()`을 직접 부르면 시간에 의존하지 않는다.
  `@Cron`이 붙은 클래스는 `scan()`을 호출하는 것 외에 아무 일도 하지 않는다.
- **기본값은 꺼짐이다**(`GUIDELINE_REVISION_SCAN_ENABLED=false`). 프로덕션 compose가 명시적으로
  켠다 — 켜짐이 기본이면 로컬·CI가 시간에 의존하고, 실수로 NCKM을 두드린다.
- 크론식은 env로 조정 가능하며 기본값은 **`0 19 * * *`(UTC) = 04:00 KST**다. 프로세스가 UTC라
  크론식도 UTC로 읽힌다 — NCKM 수정은 전부 한국 업무시간대(09:47~15:06 KST)에 일어나므로
  그날의 변경이 모두 반영된 뒤 도는 시각이다.

## Entity / 마이그레이션 변경분

**`source_documents`**: `source_modified_at` **text** nullable 추가.

- **날짜로 파싱하지 않는다.** `"Jul 30, 2026 10:05:00 AM"`은 영문 로케일·타임존 미표기 형식이라,
  파싱하면 판정이 서버 로케일에 걸린다. §18이 `release_date`를 `"2024-07"` 문자열로 보존한 것과
  같은 이유이며, 판정에 필요한 것은 **동등 비교뿐**이다.
- 기존 행은 전부 NULL이다 — 배포 직후 첫 틱에 87건 전부가 후보가 된다(아래).

**`guideline_jobs`**: 신규 enum `guideline_job_trigger`(`MANUAL`/`SCHEDULE`) + `triggered_by`
컬럼(NOT NULL, default `'MANUAL'`), `requested_by`를 **nullable로 완화**.

- 컬럼명은 `trigger`가 아니라 `triggered_by`다 — `trigger`는 예약어라 인용부호 없이 못 쓴다.
- **시스템 clinician 행을 만들지 않는다.** 실존하지 않는 의료인이 `clinicians`에 생기면 §4.4의
  테넌시 스코프와 목록·통계에 유령이 섞인다. 주체가 없는 것이 사실이므로 NULL이 사실이다.
- 두 컬럼 모두 **`GuidelineJobResponseDto`에 반영된다**(위 「범위」) — `requestedBy`는 nullable로,
  `triggeredBy`는 신규 필드로. `pnpm openapi:export` 산출을 같은 커밋에 담는다.
- NOT NULL 완화와 default 있는 컬럼 추가는 **확장 방향**이라 `automation/pipeline.md`의 2단계
  배포 대상이 아니다 — 구버전 앱은 언제나 `requested_by`를 채우고 `triggered_by`는 default를 탄다.

## 추가 에러코드

없음 — 크론은 HTTP 응답 봉투를 타지 않는다. 잡 생성 충돌은 기존 `GUIDELINE_JOB_ALREADY_RUNNING`을
스캔이 삼켜 다음 틱으로 넘긴다.

## 수용 기준 (= 동결할 시나리오, Definition of Done)

> fixture는 §19·§20·§23 규약을 따른다 — 원문이 아니라 구조를 모방한 합성 텍스트이며,
> 목록·다운로드는 §18의 fake 포트로 제어한다.

**후보 판정**

1. 본문을 받은 행이 없는 문서는 후보다 (신규 등록 — 708이 실제 사례)
2. 최신 본문 행의 `sourceModifiedAt`이 목록의 값과 **다르면** 후보다
3. 같으면 후보가 아니다
4. 비교는 **문자열 동등**이다 — 날짜로 파싱하지 않으므로 형식이 바뀌어도 「다름」으로 안전하게 기운다
5. 목록의 `modify_date`가 비어 있으면 `add_date`를 쓴다 — 둘 다 없으면 후보다(모르면 받아본다)
6. `source_documents`에 행은 있으나 본문을 못 받은 실패 행(`file_hash` NULL)뿐이면 후보다
7. 목록에서 사라진 문서는 후보가 아니다 — 폐기는 이 스텝이 다루지 않는다

**baseline 갱신**

8. 본문을 받아 **새 행이 생길 때** `sourceModifiedAt`이 기록된다
9. 본문을 받았고 **해시가 같아 새 행이 생기지 않을 때도** 기존 행의 `sourceModifiedAt`이 갱신된다
   — 이것이 없으면 파일이 안 바뀐 문서가 매일 후보로 뜬다
10. 본문 자체를 못 받은 실패에는 기록되지 않는다 — 같은 문서가 다음 틱에 **다시 후보가 된다**
11. 다운로드 성공 후 파싱이 실패한 문서는 baseline이 갱신된다 — 다음 틱에 다시 돌지 않는다

**Redis 락**

12. 락을 얻은 실행만 스캔한다
13. 락이 이미 잡혀 있으면 그 틱은 목록 조회조차 하지 않고 끝난다
14. **Redis가 죽어 락 획득이 실패하면 스캔하지 않는다** (fail-closed) — 잡도 만들지 않는다
15. 락에 TTL이 있어, 스캔 도중 프로세스가 죽어도 TTL 경과 후의 틱은 정상 진행한다
16. 스캔이 끝나면(성공·실패 무관) 락을 해제한다

**잡 위임**

17. 후보만 `externalIds`로 넘어간다 — 전건이 아니다 (후보 2건이면 잡 `total`은 2)
18. 후보가 0건이면 잡을 만들지 않는다
19. 크론이 만든 잡은 `triggeredBy=SCHEDULE`·`requestedBy=null`이다
20. 사람이 만든 잡은 `triggeredBy=MANUAL`이고 `requestedBy`가 그대로 유지된다
21. `GET /admin/guideline-jobs/{jobId}` 응답에 `triggeredBy`가 실리고, `SCHEDULE` 잡의
    `requestedBy`는 `null`로 나온다 — 관리자가 응답만으로 두 잡을 구분한다
22. 이미 활성 잡이 있으면 그 틱은 잡을 만들지 않고 **baseline도 오르지 않는다** — 같은 후보가
    다음 틱에 다시 잡힌다 (기준 10과 같은 이유: 처리하지 않은 것을 처리했다고 기록하지 않는다)

**잡 결과 통보**

> §25의 만료 알림과는 **다른 사건이라 한 잡에서 둘 다 나갈 수 있다** — 만료는 「사람이 목록을
> 갱신해야 한다」이고 잡 결과는 「이번 실행이 이렇게 끝났다」로, 수신자가 할 일이 다르다.

23. `SCHEDULE` 잡이 **정상 종결**하면 `RealTimeAlertSender`로 알림 1건이 나간다
24. `SCHEDULE` 잡이 **실패로 종결**해도(러너 사망 → `FAILED`) 알림 1건이 나간다
25. 알림 본문에 잡 ID와 `total`·`succeeded`·`skipped`·`failed` 카운트가 담긴다
26. 실패한 실행이 있으면 그 `externalId`와 `errorCode`가 본문에 담긴다 — 알림만 보고 어느
    문서를 봐야 하는지 알 수 있다
27. `MANUAL` 잡의 종결에는 알림이 나가지 않는다 — 사람이 스트림으로 지켜보고 있다(§22의 논거)
28. 목록 조회 실패로 스캔이 중단되면 알림이 나간다 — 잡이 아예 안 도는 것은 조용하면 안 된다
29. 감지 0건인 틱에는 알림이 나가지 않는다 (연 359일이 그렇다 — 매일의 정상 보고는 정작 볼
    알림을 묻는다)
30. 알림 발송 실패가 스캔 결과·잡 결과를 바꾸지 않는다 (§15의 fire-and-forget, §25 기준 9와 같은 규칙)

> 기준 23·24가 다루지 않는 종결 상태(`CANCELLED`·`INTERRUPTED`)도 **알림 대상이다** — 통보의
> 트리거는 잡의 「종결」이지 특정 status가 아니다. 크론이 만든 잡이 조용히 끝나는 경우를 두지
> 않는다.

**기동·설정**

31. `GUIDELINE_REVISION_SCAN_ENABLED`가 꺼져 있으면 크론이 등록되지 않는다 — 기본값이 꺼짐이며,
    핸들러 안에서 early return 하는 것과 구분된다(`SchedulerRegistry`에 잡이 없어야 한다)
32. e2e는 `scan()`을 직접 호출해 검증한다 — 크론식·시간에 의존하는 테스트를 만들지 않는다

## Out of scope

- **레코드 수정 없는 파일 교체의 감지** (2026-07-31 사용자 결정). `modify_date`가 안 오르고
  파일만 바뀌면 놓친다. 대응은 §22의 수동 전건 POST이며, 그때 해시가 다르면 새 행이 생겨
  잡힌다. 자동 전건(월 1회)은 **놓친 실사례가 나오면** 그때 근거를 갖고 넣는다 — 지금 넣으면
  770MB/월과 11분을 근거 없이 상시 지불한다
- **배포 직후 첫 틱의 전건 87건**은 out of scope가 아니라 **의도한 동작이다**(2026-07-31 사용자
  결정). 기존 행의 `source_modified_at`이 전부 NULL이라 87건이 후보가 되고 11분짜리 잡이 한 번
  돈다. 마지막 수동 재적재(2026-07-31) 이후의 변경을 이때 흡수하며, 변경 없는 문서는 §21의
  `contentHash`가 흡수해 임베딩을 부르지 않는다. 이후 틱은 실측대로 연 6회다
- **목록에서 사라진 문서의 폐기**(`ACTIVE` 버전 회수) — 판단이 필요한 일이고 실사례가 없다
- **자동 재개·잡 병렬 실행** — §22 그대로
- **멀티 인스턴스 운영** — 락은 그날을 위해 서 있지만, SSE fan-out(인프로세스 EventEmitter)과
  §22 부팅 시 정리(*"단일 인스턴스라 부팅 시점에 살아 있는 잡은 정의상 없다"*)는 아직 단일 전제다
- **알림 채널 추가·severity 라우팅** — §15 인프라를 그대로 쓴다
- **스캔 이력 조회 API·관리 화면** — 스캔 결과는 잡 이력(`triggeredBy=SCHEDULE`)으로 남는다
- 국외 지침(`gubun=EXT`), NCKM 외 출처 — §18 그대로
