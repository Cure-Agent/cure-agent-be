# 50. 에이전트 생존 관측 — 죽어도 모르는 상태를 닫는다

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> 완료된 spec은 커밋 로그처럼 기록으로 남을 뿐이므로, 이 디렉토리를 읽어 시스템을 이해하려 하지 말 것.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 e2e 테스트로 동결되며, 구현 중 수정할 수 없다.
> 스펙 결함 발견 시: spec을 먼저 고치고 테스트를 재동결한다 (사유를 커밋 메시지에).

## 목표

에이전트가 죽거나 멈추면 **알림이 울린다**. 끝나면 `up{instance="cure-agent"}`가 존재해 기존
`InstanceDown`이 규칙 수정 없이 에이전트를 덮고, 에이전트의 RSS를 `mem_limit: 512m`과 대조할 수 있다.
**이 스텝은 「무엇을 셀지」를 정하지 않는다** — 도메인 지표와 HTTP 요청 축은 §49 Out of scope의 유보를
그대로 둔 채, 생존 축 하나만 연다.

## 실측 조사 (2026-09-12, 운영 `cure.demo01.xyz` + 2레포 코드)

### 에이전트는 지금 어떤 알림에도 안 걸린다

| 덮을 것 같은 축 | 실측 |
|---|---|
| `InstanceDown` (`up == 0`) | **`up{instance="cure-agent"}`가 없다.** alloy의 스크레이프 대상은 host·cadvisor·`cure-app`·`cure-postgres`·`cure-redis`·prometheus 자신뿐 |
| `HighHttpErrorRate` | nginx가 `^~ /api/v1/agent/`를 에이전트로 **직접** 프록시해 BE를 거치지 않는다 → 502가 `http_requests_total`에 잡히지 않는다 |
| nginx 지표 | alloy가 nginx를 긁지 않는다 (`stub_status` 없음) |
| cAdvisor | CPU·메모리는 보이나 「요청을 처리하고 있나」는 못 본다 |
| compose healthcheck + `restart: unless-stopped` | 재시작은 하지만 **아무에게도 알리지 않는다** |
| `deploy.sh`의 에이전트 헬스 대기 | **배포 시점에만** 본다 (§49) |

### alloy는 에이전트에 네트워크로 닿지 못한다 — 망 변경이 불가피하다

| 확인 | 실측 |
|---|---|
| alloy 망 | `gcp_cure-backend` · `gcp_cure-monitoring` |
| agent 망 | `gcp_cure-proxy` — **공유 망 0개** |
| `docker exec cure-alloy getent hosts agent` | **DNS 해석 실패** (대조: `app` → `172.19.0.7`) |
| 우회로 | 없다 — prometheus의 remote-write 수신구도 `cure-monitoring`에만 있어 에이전트가 push할 수도 없고, alloy는 nginx에도 못 닿는다 |
| alloy가 이미 가진 권한 | `privileged: true` · `pid: host` · `docker.sock` · 호스트 `/` 마운트 |

### 에이전트 앱 현황 (`medical-agentic-rag@main`, 2026-09-12 푸시)

| 확인 | 실측 |
|---|---|
| 노출 경로 | `/api/v1/agent/healthz` · `/api/v1/agent/me` **둘뿐** — `create_app`이 `docs_url=None, redoc_url=None, openapi_url=None`으로 문서 경로까지 닫았다 |
| `/metrics` 응답 | `/metrics` · `/api/v1/metrics` · `/api/v1/agent/metrics` **전부 404** (운영 내부망에서 직접 조회) |
| prometheus 의존성 | **없다** — `uv.lock`에 `prometheus*` 없음 (fastapi·starlette·uvicorn만) |
| 컨테이너 | `USER 10001:10001` · `EXPOSE 8000` · `uvicorn --factory` |
| nginx 외부 표면 | `^~ /api/v1/agent/`만 에이전트로 가고 나머지는 `location /`로 app에 간다 → **접두사 밖 경로는 외부에서 에이전트에 닿지 않는다** |

### 노출 형식 모사 (`prometheus-client` 0.26.0 + `promtool` v3.11.2 — 운영과 같은 판)

기본 레지스트리를 `make_asgi_app()`으로 내보내 실제 응답과 파싱 가능성을 확인했다.

| 확인 | 실측 | 수용 기준에 미치는 영향 |
|---|---|---|
| `promtool check metrics` | **통과** — 운영 Prometheus가 파싱한다 | 이 스텝의 전제가 성립한다 |
| 모듈 상수 `CONTENT_TYPE_LATEST` | `text/plain; version=1.0.0; charset=utf-8` | — |
| **평문 GET이 실제로 받는 헤더** | `text/plain; version=0.0.4; charset=utf-8` | 상수와 다르다 — 내용 협상(`Accept`) 결과다. **버전 파라미터를 단언하지 않는다** |
| 기본 지표 (macOS) | `python_info` · `python_gc_*` 뿐 — **`process_*` 없음** | `process_resident_memory_bytes`는 Linux 전용이라 단언하면 **CI만 통과하고 로컬에서 깨진다**. 단언은 `python_info`로, RSS는 배포 후 확인으로 |

### 오늘의 요청 분포 — HTTP 축을 지금 열면 #449를 재현한다

`healthz`는 compose healthcheck가 10초마다 때리고 `me`의 FE 소비자는 0건이다(§49 「FE 변경 없음」).
지금 HTTP 메트릭을 열면 분모가 사실상 자기 헬스체크가 된다 — **BE에서 방금 고친 왜곡**(7일 104,206건 중
실사용 460건 = 0.44%, #449)이 에이전트에 새로 생긴다.

## 판단 근거 (2026-09-12 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 계측 범위 | **프로세스 메트릭만** — 공식 `prometheus-client`의 `make_asgi_app()`을 `/metrics`에 마운트한다. 얻는 것은 `up`(스크레이프 성공 여부)과 `process_*`·`python_*`이고, RSS를 `mem_limit: 512m`과 대조할 수 있다. **도메인 라벨이 0개라 카디널리티·프라이버시 판단이 아예 없다.** §49 Out of scope 「에이전트 메트릭 — 기능이 생긴 뒤에 무엇을 셀지 정한다」는 그대로 유효하다: 이 스텝은 세는 것을 정하지 않고 **긁힐 수 있게** 만들 뿐이다 |
| HTTP 요청 축 기각 | 지금 열면 분모의 대부분이 자기 헬스체크다(실측) — 쓸 수 없는 지표를 만들고 #449의 분모 오류를 새 서비스에 심는다. **기능(라우팅)이 붙어 실사용 요청이 생긴 뒤** 연다. 그때의 라벨 규칙은 BE와 같다: 사용자 입력에서 유래한 값(경로 파라미터·쿼리·traceId)을 라벨에 넣지 않고 **매칭된 라우트 템플릿**만 쓴다(`metrics.service.ts` 머리 주석) |
| 메트릭 경로 | **접두사 밖의 맨 `/metrics`.** `/api/v1/agent/metrics`로 열면 nginx가 그 접두사를 통째로 프록시하므로 **외부에 공개된다** — BE는 같은 이유로 `/api/v1/metrics`를 nginx에서 `return 404`로 막았다("라우트 목록·트래픽량·토큰 소비량이 그대로 노출되기 때문"). 접두사 밖에 두면 `location /`이 app으로 보내므로 nginx에 차단 규칙을 **더하지 않아도** 외부에서 닿지 않는다 |
| 노출 표면이 셋이 되는 것 | §49는 경로를 둘로 묶고 문서 경로까지 닫았다. `/metrics`는 그 원칙의 예외가 아니라 **범위 밖**이다 — 사용자 API가 아니고, 외부에서 도달 불가이며, 긁히지 않으면 이 스텝의 목표 자체가 성립하지 않는다 |
| 망 연결 | **alloy를 `cure-proxy`에 넣는다.** ⑴ 에이전트는 `cure-proxy`를 떠날 수 없다 — `BE_ORIGIN: http://app:3000`이고 app이 그 망에 있다. 그러니 전용 망은 이동이 아니라 추가가 되어 **§49 「망 `cure-proxy`만」을 깬다**. 수집기를 옮기면 에이전트의 도달 범위는 1비트도 안 변한다 ⑵ **선례와 같다** — alloy는 app·exporter를 긁으려 이미 `cure-backend`에 합류했다(수집기가 대상 tier로 간다) ⑶ 전용 망이 사겠다는 격리는 "alloy가 nginx에 못 닿게 한다" 하나인데, alloy는 이미 호스트 `/`와 `docker.sock`을 쥐고 있어 네트워크로 좁혀도 얻는 게 없다. **기각**: agent를 `cure-monitoring`에(외부 트래픽을 받는 서비스에 모니터링 스택 접근을 준다 — alloy 주석이 app에 대해 이미 기각한 논리) · agent를 `cure-backend`에(DB 경로가 생겨 §49의 확정 원칙이 무너진다) · 전용 `cure-agent` 망(위 ⑴~⑶) |
| 알림 등급 | **`InstanceDown`을 그대로 쓴다 — 알림 규칙 변경 0줄.** `up == 0`에 라벨 필터가 없어 대상이 등록되는 순간 자동으로 덮는다(severity `critical`, `for: 3m`). 에이전트를 제외하고 warning 규칙을 따로 두는 안은 이 자동 적용을 버리고 규칙을 둘로 늘린다. 「에이전트가 죽어도 BE는 선다」(§49)는 **가용성 격리**의 이야기지 알림이 덜 급하다는 뜻이 아니다 |
| 배포 순서 | **AGENT 먼저, BE 나중.** BE가 먼저 스크레이프 대상을 등록하면 alloy가 404를 받아 `up=0` → 3분 뒤 `InstanceDown`이 Discord로 울린다 — **자기가 자기를 페이징한다**. §49의 순서(AGENT 이미지 착지 → BE)와 같은 이유이되, 여기서는 어기면 장애가 아니라 **거짓 경보**가 난다 |
| 반영 수단 | 추가 작업이 없다 — `config.alloy` 내용이 바뀌면 #449의 재적재 단계가 alloy를 자동 재시작하고, compose 망 변경은 `up -d`가 컨테이너를 재생성한다 |

**위험.** ⑴ AGENT 배포와 BE 배포 사이에 순서가 뒤집히면 거짓 `InstanceDown`이 울린다 — 되돌리는 비용은
Discord 알림 한 건이고, BE 변경을 빼면 즉시 멈춘다. ⑵ alloy가 `cure-proxy`에 붙으면 nginx·grafana에도
닿는다 — 위 「망 연결」 ⑶의 이유로 실질 위험이 아니지만, alloy의 도달 범위가 넓어진 것은 사실이다.
⑶ `/metrics`는 내부망 누구에게나 열려 있다(BE `/api/v1/metrics`와 같은 수준) — 프로세스 지표뿐이라
노출 가치가 낮고, 외부 도달 경로는 없다.

## 범위 (진입점)

**BE 엔드포인트 신규·변경 없음.** 에이전트도 사용자 API를 더하지 않는다 — `/metrics`는 내부 수집 표면이다.

| 진입점 (AGENT — medical-agentic-rag) | 변경 |
|---|---|
| `pyproject.toml` · `uv.lock` | `prometheus-client` 추가 (공식 클라이언트. 잠금 파일 갱신) |
| `app/service/main.py` | 기본 레지스트리를 `make_asgi_app()`으로 `/metrics`에 마운트. 라우터 접두사(`/api/v1/agent`) **밖**이다 |

| 진입점 (BE) | 변경 |
|---|---|
| `docker/gcp/compose.yml` | `alloy`의 `networks`에 `cure-proxy` 추가 + 사유 주석. `agent`는 손대지 않는다 |
| `docker/gcp/monitoring/alloy/config.alloy` | `prometheus.scrape "agent"` — `__address__ = "agent:8000"` · `instance`/`job` = `cure-agent` · `metrics_path = "/metrics"` · `scrape_interval = "15s"` (기존 `app` 블록과 같은 꼴) |
| `docs/architecture.md` | §14에 에이전트 생존 관측 한 줄 — 「무엇을 셀지」는 여전히 미정임을 함께 적는다 |

**알림 규칙·nginx 변경 없음** — `InstanceDown`이 자동으로 덮고, `/metrics`는 접두사 밖이라 외부 도달 경로가 없다.

**배포 후 확인 (동결 밖)** — ① `docker exec cure-alloy getent hosts agent`가 해석된다 ② 운영 Prometheus에
`up{instance="cure-agent"}`가 `1`로 존재한다 ③ `process_resident_memory_bytes{instance="cure-agent"}`가
`mem_limit` 512MiB 안이다 ④ `https://api.cure.demo01.xyz/metrics`가 에이전트가 아니라 BE에 가서 404다.

## Entity / 마이그레이션 변경분

- 없음 — 에이전트는 저장소를 갖지 않는다(§49와 같다).

## 추가 에러코드

- 없음 — `/metrics`는 §10.1 봉투를 쓰지 않는 내부 수집 표면이고, 실패 경로를 새로 만들지 않는다.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

**에이전트가 긁힐 수 있다**

1. `GET /metrics`가 200이다 (AGENT 유닛)
2. `GET /metrics` 응답의 `Content-Type`이 `text/plain`으로 시작한다 (AGENT 유닛 — **버전 파라미터는 단언하지 않는다**: 모듈 상수는 `version=1.0.0`인데 평문 GET은 `0.0.4`를 받는다, 내용 협상 결과다. 라이브러리·`Accept` 소관인 값을 동결하면 의존성 상향에서 구현이 막힌다)
3. `GET /metrics` 본문에 `python_info` 샘플 줄이 있다 (AGENT 유닛 — 지표를 실제로 낸다는 것이 `up`의 전제다. **`process_*`로 단언하지 않는다**: `/proc`가 없는 플랫폼에서 빠져 CI만 통과하는 테스트가 된다, 실측)
4. `GET /metrics` 응답이 §10.1 봉투가 **아니다** — 본문이 JSON이 아니고 `success` 키가 없다 (AGENT 유닛 — 수집 표면은 사용자 API와 다른 계약이다)
5. `GET /metrics`가 쿠키·CSRF 헤더 없이 200이다 (AGENT 유닛 — alloy는 자격을 갖지 않는다)
6. BE에 닿을 수 없는 `BE_ORIGIN`에서도 `/metrics`가 200이다 (AGENT 유닛 — BE를 부르지 않는다, §49 기준 2와 같은 이유)

**메트릭 경로가 외부에 새지 않는다**

7. `GET /api/v1/agent/metrics`가 404다 (AGENT 유닛 — 프록시되는 접두사 안에 메트릭을 두지 않는다는 결정의 단언)
8. nginx를 지난 `GET /metrics` 요청이 app에 도달한다 (BE e2e — 회귀 가드: 접두사 밖은 `location /`이 app으로 보내므로 에이전트의 수집 표면이 외부에 노출되지 않는다. 에이전트 접두사가 agent에 도달하는 것은 §49 기준 23이 이미 동결했다)

**기존 계약이 그대로다**

9. `GET /api/v1/agent/healthz`가 200이고 `data.status`가 `ok`다 (AGENT 유닛 — 회귀 가드: §49 기준 1)
10. `/metrics` 마운트 뒤에도 없는 경로가 404 `NOT_FOUND` 봉투다 (AGENT 유닛 — 회귀 가드: ASGI 마운트가 예외 처리기를 가리지 않는다)
11. 문서 경로가 계속 닫혀 있다 — `/docs`·`/openapi.json`이 404다 (AGENT 유닛 — 회귀 가드: 노출 표면 최소화, §49)

**수집기가 에이전트에 닿는다**

12. `alloy` 서비스가 `cure-proxy` 망에 붙는다 (BE e2e — compose 파싱)
13. `alloy`가 `cure-monitoring`·`cure-backend`에도 계속 붙는다 (BE e2e — compose 파싱: 기존 수집 대상을 잃지 않는다)
14. `agent` 서비스는 여전히 `cure-proxy` 망에만 붙는다 (BE e2e — compose 파싱: §49 기준 34 회귀 가드. 수집기가 움직였을 뿐 에이전트 격리는 그대로다)
15. `agent` 환경에 `DATABASE_URL`·`REDIS_URL`이 없다 (BE e2e — compose 파싱: §49 기준 35 회귀 가드)
16. `config.alloy`에 `__address__`가 `agent:8000`이고 `metrics_path`가 `/metrics`인 스크레이프 대상이 있다 (BE e2e — 설정 파싱)
17. 그 대상의 `instance`·`job` 라벨이 `cure-agent`다 (BE e2e — 설정 파싱: `InstanceDown` 알림 문구가 `$labels.instance`를 쓰므로 이름이 곧 알림 내용이다)

**알림이 자동으로 덮는다**

18. `alerts.yml`의 `InstanceDown` 식에 `up`을 좁히는 라벨 셀렉터가 없다 (BE e2e — 규칙 파싱: 새 대상이 자동으로 덮이는 전제이고, 나중에 누가 필터를 더하면 에이전트가 조용히 빠진다)

fixture 규약: AGENT 유닛은 **실제 BE를 부르지 않는다** — §49와 같이 요청을 기록하는 fake BE(HTTP 전송 치환)를
쓰고, `/metrics` 단언은 프로세스 지표 **이름의 존재**로만 본다. 값(RSS 바이트·CPU 초)은 환경의 성질이라 단언
대상이 아니다. BE e2e는 `docker/gcp/compose.yml`·`config.alloy`·`alerts.yml`을 **사본 없이 파싱**한다(사본으로
통과하면 운영 설정을 검증한 것이 아니다 — §49 fixture 규약과 같은 이유). 기준 8은 §49가 이미 올린 nginx
Testcontainers 하네스에 요청 하나를 더하는 것이고, 새 컨테이너를 띄우지 않는다. **이 문서의 운영 수치(요청
104,206건·0.44%·512MiB)는 환경의 성질이라 단언 대상이 아니다** — 동결하는 것은 노출 형식·경로 경계·망 구성·
알림 적용 조건이다.

## Out of scope

- **에이전트 HTTP 요청·지연 지표** — 오늘은 분모가 자기 헬스체크다(판단 근거). 라우팅이 붙어 실사용 요청이
  생긴 스텝에서 열고, 그때 라벨은 매칭된 라우트 템플릿만 쓴다.
- **에이전트 도메인 지표**(분류 결과 분포·도구 호출 수·LLM 토큰) — §49의 유보 그대로. 무엇을 셀지는 기능이 정한다.
- **에이전트 전용 알림 규칙**(지연·에러율) — 셀 것이 생긴 뒤에 임계를 정한다. 임계는 실측 기반이어야 하고
  지금은 실측할 트래픽이 없다.
- **LangSmith 추적 통로** — 환자 경로 입출력 숨김과 같은 스텝에서 연다(§49 판단 근거 「추적 스위치」). 이 스텝은
  `AGENT_TRACING_ENABLED`와 compose·CD를 건드리지 않는다.
- **nginx 지표**(`stub_status`) — 에이전트 502를 에지에서 세는 다른 길이지만, 관측 대상이 nginx 전체로 넓어지고
  이 스텝의 목표(에이전트 생존)는 `up`으로 닫힌다.
- **`/metrics` 접근 제어** — 내부망 한정이라 BE `/api/v1/metrics`와 같은 수준이다. 망 안에서의 인증은 스택 전체의
  별건이다.
- **에이전트 대시보드 패널** — 지표가 들어온 뒤 무엇을 볼지가 정해진다.
- **`cure-agent` 컨테이너의 cAdvisor 지표 활용** — 이미 수집되고 있다(컨테이너 축). 이 스텝은 프로세스 축을 연다.
