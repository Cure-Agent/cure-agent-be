# 58. 외부 생존 감시 — UptimeRobot이 서버 밖에서 두 헬스 경로를 보고, 앱 알림이 처음으로 Discord에 닿는다

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> 완료된 spec은 커밋 로그처럼 기록으로 남을 뿐이므로, 이 디렉토리를 읽어 시스템을 이해하려 하지 말 것.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 e2e 테스트로 동결되며, 구현 중 수정할 수 없다.
> 스펙 결함 발견 시: spec을 먼저 고치고 테스트를 재동결한다 (사유를 커밋 메시지에).

## 목표

2026-10-20 미국 전환과 서울 destroy 뒤 운영에는 **알림 경로가 하나도 없다** — Prometheus·alertmanager(Discord)는 서울 VM과
함께 사라졌고, 앱 알림(§14 「실시간 장애 알림」)의 `ALERT_WEBHOOK_URLS`는 운영에 등록된 적이 없다. 서버가 멈춰도, 에이전트가
죽어도, LLM이 소진돼도 아무도 모른다. 끝나면 **서버 밖의 UptimeRobot(무료)이 5분마다 두 헬스 경로를 GET으로 읽어 본문 키워드가
없으면 Discord에 알리고**, 앱 알림이 같은 채널로 가며, 공개 상태 페이지가 두 모니터를 보인다. 서울 모니터링을 전제한 테스트도
정리한다 — §50 기준 12~18을 폐기하고, compose 불변식은 실제 배포 구성(`docker/gcp-us`)을 본다.

## 실측 조사 (2026-10-21, 운영(미국) 외부 요청·읽기 전용 조회 + BE·AGENT 코드 + UptimeRobot 공식 문서)

### 알림 경로가 없다

| 축 | 실측 |
|---|---|
| alertmanager → Discord | 서울 VM과 함께 10-20 destroy. `docker/gcp-us/compose.yml`은 7서비스(postgres·redis·app·agent·nginx·certbot·certbot-init)이고 수집기·규칙·알림기가 없다 |
| 앱 알림(`RealTimeAlertSender`) | 운영 app 컨테이너의 `ALERT_WEBHOOK_URLS`·`ALERT_WEBHOOK_URL` **길이 0**. 통로는 있다 — compose(`docker/gcp-us/compose.yml:98`), CD 잡 `env`(`cd-gcp-us.yml:57`)와 SSH `envs`. 빠진 것은 **저장소 시크릿**이다. 10-20 사전 점검에서 두 서버의 app env 값 해시가 같았으므로 서울도 비어 있었다. 대상이 없으면 조용히 반환한다(`real-time-alert.sender.ts`) |
| 앱 알림이 보내는 사건 | `LLM_EXHAUSTED`·`LLM_CIRCUIT_OPEN` · 5xx 봉투 코드(무시 가능 예외 제외) · `AUTH_REFRESH_REUSED` · `REDIS_UNAVAILABLE` · 크론 잡 종결 · 원문 결함 면제·목록 만료. 같은 내용은 5분 억제. 형식은 Discord `{content}`·Slack `{text}`·그 밖 구조화 JSON. 크론 잡은 개정 후보가 있을 때만 생긴다 — 10-21 04:00 KST 미국 스캔은 「개정 후보 없음 (목록 89건)」이었다 |
| 켰을 때의 소음 | 전환 뒤 약 20시간 nginx 접근 2,027건 중 **5xx 0건**, app `ERROR` 로그 0건(5xx는 이 수준으로 남는다), agent 오류 0건(10-14 기동 뒤) |

### 밖에서 볼 경로 (`https://api.cure.demo01.xyz`, 한국에서 10회)

| 경로 | 덮는 것 | 실측 |
|---|---|---|
| `GET /api/v1/health/ready` | nginx·app·DB·Redis | 200·240B, 본문 `…"data":{"status":"ready",…}`, 왕복 0.39~0.44초. DB·Redis가 끊기면 503 `SERVICE_NOT_READY`이고 봉투 `data`는 `{database, redis}`뿐이다(`readiness.service.ts:35` → `api-exception.filter.ts:59`) |
| `GET /api/v1/agent/healthz` | nginx·에이전트 | 200·191B, 본문 `…"data":{"status":"ok"}…`, 0.39~0.41초. BE를 부르지 않는다. 에이전트가 없으면 nginx가 502다(§49 기준 32) |
| HEAD | — | ready 200, **agent healthz 404** — 에이전트가 405를 404 봉투로 모은다(`app/service/main.py:111`). 내부망에서 에이전트에 직접 보내도 같다 |
| UptimeRobot UA | — | GET 200. nginx의 스캐너 UA 차단(`api.conf:64`)에 걸리지 않고, 요청 제한은 IP당 30r/s다 |

### UptimeRobot 무료 등급 (가격표·도움말·API 문서, 2026-10-21 열람)

| 항목 | 내용 |
|---|---|
| 간격·개수 | 5분 · 모니터 50개 · 데이터 보존 3개월 |
| 모니터 | HTTP(s)는 **HEAD**(재시도 때 GET, 메서드 지정은 유료) · **키워드는 GET** · ping·port. SSL·도메인 만료와 heartbeat는 유료 |
| 판정 | 상태 코드·키워드 실패는 **10초 간격 3회 재확인** 뒤 DOWN, 연결 실패(타임아웃·DNS·TLS)는 20초 간격 3회, SSL 인증서 오류는 재확인 없이 DOWN. 타임아웃 기본 30초(1~60). 다중 지역 확인은 유료 |
| 키워드 | 파싱 전 응답 본문의 부분 문자열. `keyword_type` 2 = 「키워드가 없으면 DOWN」, `keyword_case_type` 기본은 대소문자 구분 |
| 알림 | 무료 연동 5종(Google Chat·**Discord**·Pushover·Pushbullet·Splunk). 지연(threshold)·반복(recurrence)은 유료라 무료는 0 — DOWN 판정 즉시 한 번, 복구 때 한 번. 점검 창은 유료 |
| 그 밖 | 상태 페이지 1개(꾸미기 없음) · API 있음(모니터 일시정지 0·재개 1) · 「hobby and non-profit projects」 — 2024년 말부터 상업 사용을 금지했다는 2차 출처가 여럿이다 |

### 배포가 만드는 공백 (미국 CD 5회 로그, app `Recreate` → `nginx reloaded`)

| run | 공백 | 비고 |
|---|---|---|
| 38518916429 (10-14) | 4분 11초 | 첫 배포 콜드 스타트 |
| 38522610724 (10-14) | 2분 40초 | app 이중 재생성 — #530에서 고쳤다 |
| 38533176741 (10-14) | 1분 25초 | 에이전트도 재생성 — 에이전트 공백 2분 2초 |
| 39368046448 (10-20 전환) | 2분 3초 | |
| 39372362680 (10-20 #544) | 21초 | 같은 이미지 재배포 |

5분 간격 + 재확인 30초 규칙에서 공백이 D초인 배포가 DOWN을 만들 확률은 약 (D−30)/300이다 — 21초 0%, 1분 25초 18%, 2분 3초
31%. 최근 4주 main 배포는 5회(W40~W43: 1·1·2·1)라 한 달에 DOWN·UP 한 쌍 안팎이다. 편차는 e2-micro의 CPU 버스트 잔량 차이로 본다(같은 이미지 재배포가 21초, 복원 직후 배포가 2분 3초).

### 서울 구성을 읽는 테스트

| 파일 | 실측 |
|---|---|
| `test/agent-liveness-metrics.e2e-spec.ts`(§50 기준 12~18) | `docker/gcp/compose.yml`·`monitoring/alloy/config.alloy`·`prometheus/rules/alerts.yml`을 읽는다. 미국 구성에는 alloy·Prometheus가 없어 12·13·16~18을 만족시킬 수 없다. 14·15는 §49 기준 34·35와 같은 단언이다 |
| `test/agent-service-bootstrap.e2e-spec.ts`(§49 23~36·38·39, §50 8, §51 121~126) | `COMPOSE_PATH`만 `docker/gcp-us/compose.yml`로 바꾼 임시 사본이 **23/23 통과** — nginx 하네스 이미지도 같은 파일에서 읽는다 |

## 판단 근거 (2026-10-21 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 감시 위치 | **서버 밖 — UptimeRobot 무료.** 서버 안의 감시(BE가 에이전트를 부른다)는 VM·nginx·네트워크가 죽으면 알릴 주체도 함께 죽는다. **기각**: cure-fe 브라우저(페이지를 연 동안만 돌고 웹훅 주소가 공개 JS에 실린다) · Vercel 크론(Hobby는 하루 1회) · GitHub Actions 예약(정각 부하에 늦거나 빠지고, 공개 레포는 60일 활동이 없으면 예약이 꺼진다 — 감시가 조용히 멈추는 것이 감시 도구의 최악이다) |
| 모니터 종류 | **키워드 모니터 2개, 「키워드가 없으면 DOWN」.** 무료 등급에서 GET으로 요청하는 유일한 모니터다 — HTTP 모니터는 HEAD라 에이전트가 404를 내고 재시도의 GET에 기대게 된다. 본문까지 보므로 엉뚱한 서버의 200(DNS 오설정·주차 페이지)도 DOWN이다. 키워드는 따옴표까지 포함한 `"status":"ready"`·`"status":"ok"`이고, 실패 본문(503 봉투·nginx 502 HTML·404 봉투)에는 없다. **기각**: 에이전트에 HEAD 추가(AGENT 변경이 생기는데 본문은 여전히 못 본다) |
| 무엇을 보나 | **ready와 agent healthz 둘.** liveness `/api/v1/health`는 ready가 덮는다(app이 응답해야 ready도 200이다). 둘이 못 보는 것(LLM 소진·느린 응답·디스크·메모리) 중 LLM과 5xx는 앱 알림이 덮는다 |
| 배포 중 DOWN | **감수하고 문서화한다(사용자).** 공백은 실제 중단이라 알림은 사실이다. §14에 「배포 시각과 대조한다」로 남긴다. **기각**: CD가 API로 모니터를 멈췄다 재개(재개가 실패하면 감시가 꺼진 채 조용히 남고, 배포로 길어진 실제 중단까지 가린다. API 키라는 시크릿도 하나 는다) |
| 알림 채널 | **Discord만(사용자).** UptimeRobot의 기본 연락처(계정 이메일)는 두 모니터에서 뺀다. 앱 알림도 같은 채널이다. 웹훅은 **보내는 쪽마다 하나**(UptimeRobot용·앱용)다 — 하나가 새면 그것만 지우고 새로 만든다 |
| 앱 알림 웹훅 | **연결한다 — 시크릿 등록 + full 배포, 코드 변경 0.** 통로는 이미 있다(실측). UptimeRobot이 못 보는 LLM 소진(10-18에 실제로 났다)·5xx를 덮는다. 통로가 끊기면 다시 조용해지므로 기준 4~6이 통로를 지킨다 |
| 상태 페이지 | **만든다(사용자).** 무료 1개에 두 모니터를 싣는다. 표시 이름은 「API」·「Agent」로 두어 경로·구성을 드러내지 않는다 |
| §50 | **기준 12~18을 폐기한다** — 그 테스트를 지운다. 미국에는 수집기가 없고 생존 감시는 이 스펙의 외부 모니터가 맡는다. 기준 1~7·9~11(AGENT `/metrics`)과 8(BE nginx)은 남는다 — 에이전트 `/metrics`는 수집기를 다시 세울 때 쓴다 |
| compose 불변식 | **`docker/gcp-us/compose.yml`을 읽는다.** 「운영 설정을 사본 없이 파싱한다」(§49·§50 fixture 규약)는 배포되는 파일을 검증하라는 뜻이었다. 지운 서울의 파일을 읽으면 그 뜻이 사라진다 |
| 상업 사용 | **비상업 개인 프로젝트를 전제한다.** 상업화하면 유료(Solo)나 상업 사용을 허용하는 서비스로 옮긴다 |

**위험.**
- ⑴ **무료는 한 지역의 판정이다** — 그 지역의 네트워크 문제가 거짓 DOWN이 될 수 있다(다중 지역 확인은 유료).
- ⑵ **5분 간격 + 30초 재확인** — 30초 안에 끝나는 장애는 보지 못하고, 알림은 장애 시작 뒤 최대 약 5분 30초에 온다.
- ⑶ **키워드는 응답 직렬화에 묶인다** — 공백을 넣는 직렬화로 바뀌면 거짓 DOWN이 난다. 이 방향은 시끄럽게 깨진다. 조용히 깨지는 반대 방향(실패 본문에 키워드가 생김)은 BE 쪽을 기준 3이 잡는다. 에이전트 장애의 본문은 nginx 502 HTML이라 그 방향이 성립하지 않는다.
- ⑷ **UptimeRobot 설정은 레포 밖에 있다** — 재현의 원본은 아래 「운영 설정」 표와 §14다. 계정을 잃으면 그 표대로 다시 만든다.
- ⑸ **앱 알림이 처음 흐른다** — 묵혀 있던 사건(5xx·잡 결과·면제 만료)이 첫 주에 몰릴 수 있다. 전환 뒤 실측은 0건이라 많지 않을 것으로 본다.

## 범위 (진입점)

**공개 BE 엔드포인트 신규·변경 없음 — OpenAPI diff 0.** AGENT·FE 변경 없음.

| 진입점 | 변경 |
|---|---|
| `test/external-monitoring.e2e-spec.ts` (신규) | 기준 1~6 — 응답 본문 **문자열**의 키워드 계약(Testcontainers Postgres·Redis), 앱 알림 통로(운영 파일 파싱). 동결된 `test/health.e2e-spec.ts`(docs/specs/16)는 건드리지 않는다 |
| `test/agent-service-bootstrap.e2e-spec.ts` | `COMPOSE_PATH`를 `docker/gcp-us/compose.yml`로 — 단언은 그대로다(기준 7) |
| `test/agent-liveness-metrics.e2e-spec.ts` | **삭제** — §50 기준 12~18 폐기(fixture 규약 「대체되는 단언」) |
| `docker/gcp/compose.yml` | 머리 주석에서 「테스트 둘이 아직 이 파일을 읽는다」를 지운다 — 남겨 두는 이유는 모니터링 설정 하나가 된다 |
| `terraform/gcp-us/README.md` | 「모니터링이 없으니 알림도 없다」를 외부 감시로 고치고, 「전환 뒤 정리」의 테스트 항목을 완료로 표시한다 |
| `docs/architecture.md` | §14 — ① 「실시간 장애 알림」에 운영 채널(Discord, 시크릿 `ALERT_WEBHOOK_URLS`) ② **외부 생존 감시** 한 문단(모니터 2개·키워드·판정 규칙·배포 중 DOWN의 해석·못 보는 것) ③ 서울 모니터링 서술(설정 재적재 ⑴의 모니터링 파일·알림 설계 원칙·에이전트 생존 관측)을 「서울 시절(`docker/gcp`, 비활성) — 수집기를 다시 세울 때의 전제」 한 문단으로 줄인다. 설정 재적재 ⑴의 nginx conf 부분은 미국에도 그대로다 |

**운영 설정 (동결 밖 — 사용자가 한다)**

| 대상 | 설정 |
|---|---|
| Discord | 알림 채널에 웹훅 2개 — 「UptimeRobot」·「cure-agent」 |
| UptimeRobot 연락처 | Discord 연동(「UptimeRobot」 웹훅). 계정 이메일 연락처는 두 모니터에서 뺀다 |
| 모니터 「API」 | 키워드 · `https://api.cure.demo01.xyz/api/v1/health/ready` · 키워드 `"status":"ready"` · 없으면 DOWN · 대소문자 구분 · 5분 · 타임아웃 30초 |
| 모니터 「Agent」 | 키워드 · `https://api.cure.demo01.xyz/api/v1/agent/healthz` · 키워드 `"status":"ok"` · 나머지는 「API」와 같다 |
| 상태 페이지 | 1개 — 「API」·「Agent」 |
| GitHub 시크릿 | `ALERT_WEBHOOK_URLS` ← 「cure-agent」 웹훅 주소(값은 사용자가 넣는다). **이 스펙의 BE 구현을 배포하기 전에 등록하고, 그 구현을 `full`로 배포해** 시크릿을 싣는다 — 시크릿은 배포가 컨테이너에 넣으므로 그 전의 app은 빈 값이다 |

> **대시보드 기본값이 이 표와 다르다**(dashboard.uptimerobot.com, 2026-10-22 확인). 키워드 조건의 기본은 「키워드가 **있으면**
> 장애」라서 「없으면」으로 바꾼다. 대소문자 구분은 기본으로 꺼져 있어 켠다. Discord는 모니터마다 「Integrations & Team」 탭에서
> 기본으로 꺼져 있고 E-mail은 기본으로 켜져 있어 둘 다 바꾼다. 표시 이름은 URL 호스트로 자동 입력돼 두 모니터가 같아지므로
> 이름을 바꾼다. 상태 페이지에는 모니터를 하나씩 추가하고 「모두 추가」·자동 추가는 쓰지 않는다(뒤에 생기는 모니터가 저절로 실린다).

**배포 후 확인 (동결 밖)**
- ① 배포 뒤 운영 app의 `ALERT_WEBHOOK_URLS` 길이가 0이 아니다(값은 찍지 않는다).
- ② 「cure-agent」 웹훅에 시험 메시지를 한 번 POST해 채널에 보인다. 앱 경로의 첫 실제 알림은 자연 발생(5xx·잡 결과)을 기다린다.
- ③ 두 모니터가 UP이고 응답 시간이 실측(약 0.4초) 근처다. 상태 페이지에 두 모니터가 보이고 URL은 드러나지 않는다.
- ④ **임시 실패 모니터**(「API」와 같은 URL에 없는 키워드)를 만들어 Discord에 DOWN이 오고 이메일은 오지 않는 것을 본 뒤 지운다 — 운영을 멈추지 않고 알림 경로를 확인한다.
- ⑤ 다음 배포 한 번의 CD 로그와 UptimeRobot 기록을 대조한다 — 공백 길이와 DOWN 여부(판단 「배포 중 DOWN」).
- ⑥ 다음 04:00 KST 스캔 시간대에 응답 시간이 타임아웃 30초 안이다.

## Entity / 마이그레이션 변경분

- 없음.

## 추가 에러코드

- 없음 — 공통 코드로 충분.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

**모니터가 읽는 본문** (UptimeRobot 키워드는 파싱 전 응답 본문의 부분 문자열로 판정한다)

1. `GET /api/v1/health/ready`가 200이고 응답 본문 **문자열**에 `"status":"ready"`가 있다 (BE e2e — 파싱한 `data.status`가 아니라 원문을 본다. 공백 없는 직렬화까지가 계약이다)
2. Redis가 끊긴 상태의 `GET /api/v1/health/ready`가 503이다 (BE e2e — 스위트의 Testcontainers Redis를 멈춘 뒤)
3. 그 503 응답 본문 문자열에 `"status":"ready"`가 없다 (BE e2e — 양성 대조는 1. 이 방향이 깨지면 DB·Redis 장애에도 모니터가 UP으로 남는다)

**앱 알림 통로** (운영 파일을 사본 없이 파싱한다 — §50 fixture 규약과 같은 이유)

4. `docker/gcp-us/compose.yml`의 `app` 환경에 `ALERT_WEBHOOK_URLS` 키가 있다 (BE e2e)
5. `cd-gcp-us.yml`의 `deploy-us` 잡 `env.ALERT_WEBHOOK_URLS`가 `${{ secrets.ALERT_WEBHOOK_URLS }}`다 (BE e2e)
6. 그 잡의 SSH 배포 단계 `envs` 목록에 `ALERT_WEBHOOK_URLS`가 있다 (BE e2e — 잡 `env`에 있어도 `envs`에 없으면 원격 셸에 생기지 않아 컨테이너가 빈 값을 받는다)

**운영 구성 테스트가 운영 구성을 본다**

7. `agent-service-bootstrap.e2e-spec.ts`가 `docker/gcp-us/compose.yml`을 읽고, 스위트의 기존 단언(§49 기준 23~36·38·39, §50 기준 8, §51 기준 121~126)이 그대로 통과한다 (BE e2e — 단언은 바꾸지 않는다)

**공개 계약**

8. 커밋된 OpenAPI가 바뀌지 않는다 (BE contract)

fixture 규약:
- **BE e2e는 §13대로 Testcontainers**다. 기준 1~3은 새 스위트가 자기 Postgres·Redis 컨테이너로 앱을 띄우고, 기준 2·3은 **Redis 컨테이너를 멈춘 뒤** 요청한다 — 다른 단언과 순서가 섞이지 않게 스위트 끝이나 별도 `describe`에 둔다. 멈춘 직후의 첫 요청은 클라이언트가 끊김을 알기 전일 수 있으므로, 503이 나올 때까지 제한 시간 안에서 다시 요청한다(시각 추측이 아니라 상태로 기다린다). 본문은 `supertest`의 `res.text`(파싱 전)로 단언한다.
- 기준 4~6은 `yaml`로 **운영 파일을 사본 없이** 파싱한다(§49·§50 fixture 규약과 같은 이유). `envs`는 쉼표로 구분된 문자열이라 나눠 공백을 다듬은 뒤 포함 여부를 본다.
- **대체되는 단언**: `test/agent-liveness-metrics.e2e-spec.ts`(§50 기준 12~18)는 이 스펙이 폐기한다 — **Phase 2에서 파일을 지우고 사유를 동결 커밋에 남긴다**(§56 fixture 규약과 같은 예외 — 스펙이 결정을 뒤집었다). `agent-service-bootstrap.e2e-spec.ts`는 `COMPOSE_PATH` 한 줄만 바꾸고 사유를 같은 커밋에 남긴다. 나머지 단언은 새 경로에서도 참이다(작성 시점 23/23).
- **기준 1~8은 전부 오늘 코드에서도 참인 회귀 가드다** — BE 코드가 바뀌지 않는다(이 스텝의 변경은 운영 설정과 테스트 정리다). 그래서 동결 게이트(`automation/freeze.md` 5번 ③)의 스텁 RED가 성립하지 않고 스텁 준비는 비어 있다. 건별 정당화는 이 줄이며, **동결 판정은 아래 뮤테이션에서 각 기준이 RED가 되는지로 한다**(§57 기준 16과 같은 방법). 기준 1: `readiness.service.ts`의 `status: 'ready'`를 다른 값으로 · 기준 2: `probe`가 늘 `up`을 반환 · 기준 3: 503 봉투 `data`에 `status: 'ready'`를 더함 · 기준 4~6: 해당 줄(compose 키·잡 `env`·`envs` 항목)을 지움 · 기준 7: `docker/gcp-us/compose.yml`의 agent `networks`에 `cure-backend`를 더함(서울 파일은 그대로 — 스위트가 미국 파일을 읽는다는 증거) · 기준 8: 기존 contract 스위트 그대로.
- **이 문서의 수치는 단언 대상이 아니다** — 배포 공백·확률·요청 건수·응답 시간은 운영의 상태다. 동결하는 것은 키워드 계약·실패 본문의 키워드 부재·알림 통로·테스트가 읽는 구성이다.

## Out of scope

- **SSL·도메인 만료 감시, heartbeat(크론 생존), 느린 응답 알림, 다중 지역 확인** — 유료다. 인증서가 만료되면 HTTPS 요청이 실패해 두 모니터가 재확인 없이 DOWN이 된다(만료 전 경고는 없다).
- **서버 안 지표(디스크·메모리·CPU)와 수집기 재건** — 1GB에 수집기를 올리지 않는다(미국 전환의 결정). 다시 세우면 §50과 `docker/gcp`의 설계가 출발점이다.
- **에이전트의 HEAD 지원** — 키워드 모니터가 GET이라 필요 없다. HTTP 모니터로 바꿀 때 다시 본다.
- **배포 중 경보 억제** — 판단 「배포 중 DOWN」 그대로다.
- **UptimeRobot 설정의 코드화**(API·Terraform) — 모니터가 둘이라 표로 재현한다.
- **에이전트 쪽 키워드 회귀 테스트** — 깨지면 거짓 DOWN으로 시끄럽게 드러난다(위험 ⑶). 이 스텝에 AGENT 레포를 넣지 않는다.
- **앱 알림의 사건·억제 창 조정** — docs/specs/15 그대로다. 첫 주 소음을 본 뒤 정한다.
