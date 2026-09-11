# 49. 에이전트 서비스 도입 — 기능 없이 경로를 끝까지 잇고 인증 전달을 증명한다

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> 완료된 spec은 커밋 로그처럼 기록으로 남을 뿐이므로, 이 디렉토리를 읽어 시스템을 이해하려 하지 말 것.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 e2e 테스트로 동결되며, 구현 중 수정할 수 없다.
> 스펙 결함 발견 시: spec을 먼저 고치고 테스트를 재동결한다 (사유를 커밋 메시지에).

## 목표

`medical-agentic-rag`를 세 번째 구현 레포(에이전트 서비스)로 들인다. 이 스텝은 **기능을 만들지 않는다** —
브라우저 → nginx → 에이전트 → BE로 이어지는 경로를 운영까지 깔고, 에이전트가 **받은 사용자 쿠키를 그대로
BE에 넘겨 BE의 인증 판정을 돌려받는다**는 사실 하나를 증명한다. 끝나면 로그인한 브라우저에서
`GET /api/v1/agent/me`가 자기 `clinicianId`를 돌려주고, 에이전트가 죽어도 BE는 영향을 받지 않는다.
라우팅·환자·재고 경로는 이 경로 위에 얹힌다.

## 실측 조사 (2026-09-11, 3레포 코드 + 운영 `cure.demo01.xyz` + 로컬 Docker 실험)

### 에이전트 접두사는 이미 BE까지 온다 — FE 변경이 없다

| 확인 항목 | 실측 |
|---|---|
| FE 요청 경로 | `API_BASE_URL` 빈 값 → same-origin(`cure-agent-fe/src/shared/config/env.ts:2`), Next rewrites가 `/api/v1/:path*`를 통째로 BE 도메인으로 보낸다 |
| 운영 `GET https://cure.demo01.xyz/api/v1/agent/healthz` | **404 `NOT_FOUND`(BE 봉투)** — 접두사가 FE 프록시와 nginx를 지나 이미 `app`에 닿는다 |
| 인증 쿠키 | `access_token`·`refresh_token` 둘 다 `Path=/`(`auth-cookie.factory.ts:55`) → 에이전트 경로에도 **둘 다 실린다**. `oauth_state`만 `/api/v1/auth/oauth`로 좁혀져 있다(`:8`) |
| access 수명 | **900초** — `auth.config.ts:6` 기본값, compose 기본값, CD 미지정 |
| refresh | 회전식 + 재사용 감지 → family 전체 폐기(`auth.service.ts:210-223`). 운영 감지 2건이 **회전 67·83ms 뒤의 동시 refresh 경합**이었다(§39) |
| FE의 401 처리 | **경로와 무관하다** — 401이면 FE가 `/auth/refresh`를 직접 부르고 원 요청을 1회 재시도한다(`http.ts:91-99`). SSE는 **스트림 시작 전 401만** 복구한다(`stream-client.ts:47-57`) |
| CSRF | 상태 변경 요청은 `X-CSRF-Protection`의 **존재**만 본다(`csrf.guard.ts:18-19`). FE SSE 클라이언트는 항상 붙인다(`stream-client.ts:38`) |

### nginx — 정적 해석은 에이전트 부재를 BE 전면 장애로 번지게 한다 (nginx 1.31.5, 운영과 같은 판)

받은 헤더를 본문으로 되돌려주는 stub `app`·`agent` 위에서 두 구성을 비교했다.

| 구성 | agent 컨테이너 없음 | agent 기동 후 |
|---|---|---|
| 정적 `proxy_pass http://agent:8000` (오늘 `app`과 같은 방식) | `[emerg] host not found in upstream "agent"` → **nginx exit 1** — BE 경로까지 죽는다 | 기동 |
| 변수 `proxy_pass` + `resolver 127.0.0.11` | 기동 · 에이전트 경로 **502** · BE 경로 **200** | 200 · agent를 지우면 502 · **재기동 12초 뒤 nginx 재시작 없이 200** |

| 보낸 요청 | 받은 쪽이 본 헤더 |
|---|---|
| `access_token=AAA; refresh_token=RRR; other=1` + CSRF → 에이전트 경로 | agent: Cookie `access_token=AAA` · CSRF `1` |
| `refresh_token=RRR`만 → 에이전트 경로 (access 만료 후의 흔한 상태) | agent: **Cookie 헤더 없음** |
| 두 토큰 → `/api/v1/auth/me` | app: 두 토큰 그대로 — 재작성은 에이전트 location에만 걸린다 |
| `/api/v1/agentx/y` | app — 접두사 경계는 슬래시다 |

재작성은 `map $cookie_access_token`으로 `access_token=<값>`을 만들고, 값이 비면 헤더를 생략한다(nginx는 빈
`proxy_set_header`를 보내지 않는다).

### LangSmith — SDK 환경변수로는 「꺼짐」을 고정할 수 없다 (langsmith 0.11.0 · langchain-core 1.5.6)

네트워크 없이 `CallbackManager.configure()`에 트레이서가 붙는지로 판정했다(엔드포인트는 닿지 않는 주소).

| 환경 | 트레이서 |
|---|---|
| 없음 · API 키만 · `LANGSMITH_TRACING=`(빈 값) · `=True`(대문자) | 안 붙음 |
| `LANGSMITH_TRACING=true` · `LANGCHAIN_TRACING_V2=true`(교안 방식) · 키 없이 `true` | **붙음** |
| `LANGSMITH_TRACING=false` + `LANGCHAIN_TRACING_V2=true` | **붙음 — `false`가 이기지 못한다** |
| 위 조합 + 기동 시 `langsmith.configure(enabled=False)` | 안 붙음 — **전역 스위치가 환경변수를 이긴다** |

SDK는 `LANGSMITH_`·`LANGCHAIN_` 두 네임스페이스에서 `TRACING_V2`를 먼저 찾아 `"true"`와 문자열 비교한다
(`langsmith/utils.py` `tracing_is_enabled`). 어느 쪽이든 `true` 한 줄이면 켜진다.

### 운영 자원과 에이전트 이미지

| 항목 | 실측 |
|---|---|
| 운영 VM (`docker stats`) | 2 vCPU · 메모리 사용 **1,378 / 7,936MiB** · 컨테이너 12종 실사용 합 ≈727MiB · `mem_limit` 합 ≈5.9G · 디스크 14G / 48G |
| 이미지 모사 — `python:3.13-slim` + FastAPI·uvicorn·LangGraph·langchain-openai·httpx (arm64) | **271MB** · 기동 ≈2초 · 요청 200회 후 RSS **108MiB** · 기본 **uid 0(root)** |
| `medical-agentic-rag` 현황 | 실험 하네스다 — 기동 시 psycopg 풀로 **DB에 직접 붙고**(`app/main.py:16-21`) 경로는 접두사 없는 `/healthz`·`/ask`·`/ask/stream`이다. Dockerfile·CI·의존성 잠금 파일이 없다. 공개 레포, 기본 브랜치 `main` |

## 판단 근거 (2026-09-11 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 에이전트의 몫 | **판단만 한다 — RAG·환자·재고 데이터와 권한은 전부 BE API에 둔다**(확정 원칙). BE는 이미 가드·denylist(§4.3)·클리닉 스코프(§4.4)를 갖고 있다. 에이전트가 데이터에 직접 닿으면 권한 판단이 두 곳이 되어 스코프 강제가 갈라진다. 이 스텝은 원칙을 **구조로** 박는다 — 에이전트 컨테이너는 `cure-proxy` 망에만 붙어 DB·Redis로 가는 경로 자체가 없다 |
| 진입점 | **기존 채팅은 그대로 두고 `/api/v1/agent/` 별도 진입점을 쓴다**(확정 원칙). 채팅 파이프라인이 쌓은 게이트·평가(§27~§48)를 흔들지 않고 병행한다. 브라우저에게는 여전히 `/api/v1` 하나이고 분기는 nginx가 한다 |
| 자격 전달 | **받은 Cookie와 CSRF 헤더를 그대로 BE에 넘긴다**(확정 원칙) — 에이전트는 자격을 만들지 않는다. CSRF 헤더는 **받았을 때만** 넘긴다: 에이전트가 스스로 붙이면 헤더 없는 교차 출처 요청이 에이전트를 경유해 CSRF 가드를 통과한다 |
| refresh_token 처분 | **nginx가 에이전트 location에서 Cookie를 `access_token` 하나로 재작성한다.** ⑴ refresh는 FE가 경로와 무관하게 전담하므로 에이전트에는 쓸모가 없다 — 에이전트가 BE의 401을 돌려주면 FE가 refresh 후 재시도한다 ⑵ **에이전트가 쓰면 깨진다** — 회전으로 브라우저의 refresh가 구 토큰이 되어 다음 FE refresh가 재사용 감지 → family 폐기 → 로그아웃이 된다. Set-Cookie를 돌려줘도 동시 refresh 경합이 남는다(운영 감지 2건이 바로 그 경합이다) ⑶ 14일 수명 토큰이 서드파티 SDK·추적이 도는 Python 프로세스에 **도달조차 하지 않는다** ⑷ BE 쿠키 정책·FE가 그대로다. **기각**: refresh 쿠키 Path 축소(근본 해법이지만 §4.1 개정과 기존 `Path=/` 쿠키가 최대 14일 공존하는 이행이 딸린 인증 정책 변경) · 에이전트 코드에서 제거(프로세스까지는 도달한다) · API 게이트웨이(토큰 교환과 BE가 내부 토큰을 신뢰하는 새 경로가 필요한데, 지금의 에지 요구는 nginx 설정 몇 줄로 닫힌다) |
| 에이전트 upstream 해석 | **요청 시점 해석(`resolver 127.0.0.11` + 변수 `proxy_pass`).** 정적 해석이면 에이전트 컨테이너가 없거나 재시작 중일 때 nginx가 기동하지 못해 **BE까지 전면 장애**다(실측) — 재부팅 순서나 에이전트 크래시 루프에서 실제로 생긴다. 기능 없는 부속 서비스가 핵심 경로의 가용성을 쥐게 두지 않는다. `app`은 정적 그대로 둔다 — 핵심 의존이라 결합이 곧 사실이다 |
| BE 호출 주소 | **내부 `http://app:3000`**(`BE_ORIGIN` — FE rewrites와 같은 이름). 공개 주소로 돌면 nginx를 한 번 더 지나며 `auth_limit` 5r/s를 **모든 사용자가 에이전트 IP 하나로 나눠 쓴다** |
| 상류 실패 매핑 | **BE가 응답하면 상태와 봉투를 그대로, 응답을 못 받으면(연결 실패·시간 초과) 502.** 401로 뭉개면 BE 순단이 FE의 refresh 실패 → **강제 로그아웃**이 된다. `INTERNAL_ERROR`(500)는 §10.1상 「우리 코드의 결함」이라 틀린 귀속이다 |
| 응답 봉투·코드 | **에이전트의 JSON 응답도 §10.1 봉투다** — FE에게 `/api/v1`은 하나의 API 표면이다. 코드는 BE 레지스트리가 단일 소스이므로(§10.2) 에이전트가 발신하는 코드도 거기 등록하고, 에이전트는 문자열을 미러링한다 |
| `me`가 싣는 것 | **`clinicianId`·`clinicId`뿐이다.** 증명에 필요한 최소이고, 클리닉 id는 이후 환자·재고 경로의 스코프가 실제로 전달됨을 보인다. `email`·`displayName`을 에이전트 응답·추적 표면에 올릴 이유가 없다 |
| healthz | **프로세스 생존만 보고 BE를 부르지 않는다** — §16이 liveness와 readiness를 가른 것과 같은 이유다. BE를 보게 하면 BE 장애가 에이전트 재시작·배포 롤백으로 번진다 |
| 추적 스위치 | **`AGENT_TRACING_ENABLED`(`true`만 발동) 하나가 기동 시 SDK 전역 스위치를 쥔다.** SDK 환경변수는 한쪽 네임스페이스의 `true`로 켜지고 `false`로 끌 수 없어(실측) 교안식 `.env` 한 줄이 조용히 추적을 켠다. **운영 통로(compose·CD)는 이 스텝에서 열지 않는다** — 환자 경로 입출력 숨김(확정 원칙)과 같은 스텝에서 열어, 켜는 수단과 숨기는 수단이 같은 날 생기게 한다 |
| 검증 수단 | **동작은 컨테이너 테스트로 동결한다.** nginx 분기·Cookie 재작성·에이전트 부재 격리는 운영 `api.conf`를 그대로 올린 Testcontainers e2e로(CI `test:e2e`가 이미 Docker로 돈다), compose 불변식은 파일 파싱 테스트로 동결한다. **deploy.sh·워크플로우는 동결하지 않고** 첫 CD 로그와 배포 후 확인으로 검증한다 — 셸 스크립트를 돌릴 테스트 하네스가 CI에 없고(`automation/bin/smoke-test.sh`도 CI 잡에 연결돼 있지 않다), 에이전트 롤백은 app 롤백과 같은 구조다 |
| 배포 실패 처리 | **에이전트 헬스 실패 → 에이전트만 이전 태그로 롤백하고 배포는 실패(exit 1)로 끝낸다.** 조용히 성공 처리하지 않는다 — 인프라 구축 때 alertmanager가 crash loop인데 app 헬스만 봐서 배포가 성공으로 지나간 전례가 있다. 대가는 위험 ⑵다 |
| 배포 순서·단독 배포 | **AGENT 이미지가 GHCR에 먼저 있어야 한다** — 없으면 `compose pull`이 실패해 deploy.sh가 마이그레이션 전에 멈춘다(장애는 아니지만 BE 배포가 막힌다). 순서는 AGENT 하네스 이식 → AGENT 구현(이미지 착지) → BE 구현·배포다. 에이전트 단독 배포는 `cd-gcp.yml`의 `workflow_dispatch`(`agent_image_tag`)로 하고, 교차 레포 자동 트리거는 두지 않는다 — 기능이 없어 자동화가 지킬 것이 없다 |
| 메모리 한도 | **`mem_limit: 512m`.** 이후 스텝의 의존성을 미리 적재한 모사 이미지가 RSS 108MiB라 LangGraph 실행분 여유가 4배 남짓이고, 한도 합이 ≈5.9G → ≈6.4G로 7.75G 안에 든다 |

**위험.** ⑴ **실행 도중 access 만료** — 에이전트는 BE를 부를 때마다 재인증되는데 FE는 스트림 시작 전 401만
복구한다. 이 스텝의 `me`는 호출 1회라 무관하지만, BE를 여러 번 부르는 첫 스텝(라우팅)이 반드시 정해야 한다.
⑵ 에이전트 `latest`가 깨져 있는 동안 BE 배포도 실패로 끝난다 — 에이전트 CI가 테스트 통과 후에만 이미지를
올리는 것이 1차 방어다. ⑶ 요청 시점 해석의 캐시(`valid=10s`) 때문에 에이전트 재생성 직후 최대 10초간 502가
날 수 있다. ⑷ Cookie 재작성은 **운영 nginx 한 곳의 보증**이다 — nginx 없는 로컬 개발에서는 에이전트가
refresh_token까지 받는다. ⑸ 전역 스위치가 환경변수를 이긴다는 것은 langsmith 0.11.0 실측이다 — SDK를
올려 우선순위가 바뀌면 기준 16~18이 먼저 알려준다.

## 범위 (엔드포인트)

**BE 엔드포인트 신규·변경 없음** — BE는 경로·배포 구성과 레지스트리 한 줄만 바뀐다. 에이전트 엔드포인트는
BE `openapi/`에 들어가지 않는다(에이전트 API의 FE 계약은 Out of scope).

| API (AGENT) | Request | Response data | 참조 |
|---|---|---|---|
| `GET /api/v1/agent/healthz` | — | `{ status: 'ok' }` | §10.1 |
| `GET /api/v1/agent/me` | `Cookie`·`X-CSRF-Protection` — 받은 그대로 BE로 | `{ clinicianId, clinicId }` · BE 오류는 상태·봉투 그대로 · 상류 실패 502 | §4.2 · §10.1 |

| 진입점 (AGENT — medical-agentic-rag) | 변경 |
|---|---|
| 서비스 앱 (신규) | 위 두 경로만 노출하고 **DB 풀을 열지 않는다** — 기존 실험 앱(`app/main.py`)과 진입점을 분리한다. 요청마다 ULID `traceId`(§10.3) |
| BE 클라이언트 (신규) | `BE_ORIGIN`(기본 `http://localhost:3000`) + `/api/v1/auth/me`. 받은 `Cookie`는 그대로, `X-CSRF-Protection`은 받았을 때만 싣고 그 밖의 요청 헤더는 넘기지 않는다. 연결 실패·시간 초과 → 502 `AGENT_BACKEND_UNAVAILABLE` |
| 설정 | `AGENT_TRACING_ENABLED`(`true`만 발동) → 기동 시 `langsmith.configure(enabled=…)`로 SDK 전역 스위치를 고정한다 |
| `Dockerfile` (신규) | 비-root 실행 · 의존성 잠금 파일로 설치(BE `--frozen-lockfile`과 같은 이유) · 추적 변수를 `ENV`로 박지 않는다 |
| CI 워크플로우 (신규) | PR: 테스트 + 이미지 빌드. `main` push: `linux/amd64` 빌드 → `ghcr.io/cure-agent/medical-agentic-rag`에 `latest`·실행 번호 태그로 푸시(BE `ci-ghcr.yml`과 같은 태그 규칙) |

| 진입점 (BE) | 변경 |
|---|---|
| `nginx/conf.d/api.conf` | `location ^~ /api/v1/agent/` 신설 — `resolver 127.0.0.11` + 변수 `proxy_pass`, `map $cookie_access_token`으로 Cookie 재작성(값이 없으면 헤더 생략). 요청 제한·타임아웃·버퍼링은 일반 API location과 같게 둔다 |
| `docker/gcp/compose.yml` | `agent` 서비스 — 컨테이너 `cure-agent` · 이미지 `ghcr.io/cure-agent/medical-agentic-rag:${AGENT_IMAGE_TAG:-latest}` · `mem_limit: 512m` · 망 `cure-proxy`만 · `BE_ORIGIN: http://app:3000` · healthcheck. `nginx.depends_on`에 넣지 않는다. 머리 주석의 메모리 배분 갱신 |
| `deploy.sh` | 에이전트 태그 롤백 파일(`.previous_agent_image_tag`) · app 헬스 뒤 `cure-agent` 헬스 대기 · 실패 시 에이전트만 롤백하고 exit 1 · 미사용 에이전트 이미지 정리 |
| `.github/workflows/cd-gcp.yml` | `AGENT_IMAGE_TAG`(env·envs 목록) · dispatch 입력 `agent_image_tag` |
| `error-code.registry.ts` | `AGENT_BACKEND_UNAVAILABLE`(502) — BE는 던지지 않고 에이전트가 발신한다는 사유 주석 |
| `package.json` | devDependency `testcontainers`(지금은 postgres·redis 모듈의 전이 의존이라 직접 import가 안 된다) · YAML 파서(compose 파싱) |
| `docs/architecture.md` | §0 결정 요약에 에이전트 행 · §4.1에 에이전트 경로의 쿠키 처분 · §14(관측·운영)에 추적 스위치 |

**FE 변경 없음** — Next rewrites가 이미 `/api/v1/agent/*`를 BE 도메인까지 보낸다(실측 404 봉투).

**배포 후 확인 (동결 밖)** — ① `https://cure.demo01.xyz/api/v1/agent/healthz`가 200(오늘 404) ② 로그인한 탭에서
`fetch('/api/v1/agent/me')`가 200 + 자기 `clinicianId`, 로그아웃 상태에서 401 ③ `cure-agent` 컨테이너 안에서
`postgres` 이름이 해석되지 않는다(망 격리) ④ CD 로그에 에이전트 헬스 대기 통과 줄이 있다.

## Entity / 마이그레이션 변경분

- 없음 — 에이전트는 저장소를 갖지 않는다.

## 추가 에러코드

- `AGENT_BACKEND_UNAVAILABLE` (502) — 에이전트가 BE에서 응답을 받지 못했다(연결 실패·시간 초과). 기존 502
  코드는 도메인 특정(`GUIDELINE_SOURCE_UNAVAILABLE`·`GUIDELINE_EMBEDDING_FAILED`)이고, 401로 쓰면 FE가 refresh →
  로그아웃으로 오판하며, `INTERNAL_ERROR`는 코드 결함이라는 틀린 귀속이다.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

**에이전트가 산다**

1. `GET /api/v1/agent/healthz`가 쿠키 없이 200이고 `data.status`가 `ok`다 (AGENT 유닛)
2. BE에 닿을 수 없는 `BE_ORIGIN`에서도 healthz가 200이다 — BE를 부르지 않는다 (AGENT 유닛)

**받은 자격을 그대로 넘긴다**

3. `GET /api/v1/agent/me`가 받은 `Cookie` 값을 **바꾸지 않고** BE `GET /api/v1/auth/me`에 싣는다 (AGENT 유닛 — 요청을 기록하는 fake BE로 단언)
4. BE 호출 대상이 `BE_ORIGIN` 설정을 따른다 (AGENT 유닛)
5. 요청에 `X-CSRF-Protection`이 있으면 같은 값을 BE 호출에 싣는다 (AGENT 유닛)
6. 요청에 `X-CSRF-Protection`이 없으면 BE 호출에도 없다 — 에이전트가 만들어 붙이지 않는다 (AGENT 유닛)

**BE의 판정을 그대로 돌려준다**

7. BE가 200이면 200이고 `data.clinicianId`가 BE 응답의 `data.id`다 (AGENT 유닛)
8. BE가 200이면 `data.clinicId`가 BE 응답의 `data.clinic.id`다 (AGENT 유닛)
9. 성공 응답 어디에도 BE 응답의 `email`·`displayName` 값이 없다 (AGENT 유닛)
10. 성공 응답이 §10.1 봉투다 — `success=true`·`code`·`message`·`data`·`page`·`timestamp`·`traceId` (AGENT 유닛)
11. BE가 401이면 401이다 (AGENT 유닛 — FE의 refresh → 재시도가 이 상태 하나에 걸려 있다)
12. BE가 401 봉투에 담은 `code`가 그대로다 — `UNAUTHORIZED`·`AUTH_TOKEN_EXPIRED` 각각 (AGENT 유닛)
13. BE 연결이 실패하면 502 `AGENT_BACKEND_UNAVAILABLE`이다 (AGENT 유닛 — 401이 아니다)
14. BE 호출이 시간 초과로 끝나도 502 `AGENT_BACKEND_UNAVAILABLE`이다 (AGENT 유닛 — 연결 실패와 다른 예외 경로다)

**추적은 앱이 켤 때만 켜진다**

15. 추적 관련 환경변수가 하나도 없으면 LangChain 콜백에 LangSmith 트레이서가 없다 (AGENT 유닛 — 회귀 가드: SDK 기본값과 같다)
16. `LANGSMITH_TRACING=true`여도 `AGENT_TRACING_ENABLED`가 없으면 트레이서가 없다 (AGENT 유닛 — SDK 단독이면 붙는다, 실측)
17. `LANGCHAIN_TRACING_V2=true`여도 `AGENT_TRACING_ENABLED`가 없으면 트레이서가 없다 (AGENT 유닛 — 교안 방식)
18. `AGENT_TRACING_ENABLED=true`면 트레이서가 붙는다 (AGENT 유닛 — 스위치가 실제로 켠다)
19. `AGENT_TRACING_ENABLED`는 `true`만 발동한다 — 빈 값·`1`·`True`는 꺼짐 (AGENT 유닛)

**이미지**

20. 이미지로 띄운 컨테이너에서 `/api/v1/agent/healthz`가 200이다 (AGENT 컨테이너)
21. 컨테이너 프로세스가 uid 0이 아니다 (AGENT 컨테이너 — `python:3.13-slim` 기본은 root, 실측)
22. 이미지 환경에 `AGENT_TRACING_ENABLED`·`LANGSMITH_*`·`LANGCHAIN_*` 변수가 없다 (AGENT 컨테이너)

**nginx가 경로를 나누고 refresh를 막는다**

23. `/api/v1/agent/` 아래 요청이 agent에 도달한다 (BE e2e)
24. 그 밖의 `/api/v1/` 요청은 app에 도달한다 — `/api/v1/auth/refresh` 포함 (BE e2e — 회귀 가드)
25. 접두사만 겹치는 `/api/v1/agentx/…`는 app에 도달한다 (BE e2e — 회귀 가드: 경계는 슬래시다)
26. access·refresh·기타 쿠키를 함께 보내면 agent가 받는 Cookie는 `access_token=<보낸 값>` 하나다 (BE e2e)
27. `refresh_token`만 보내면 agent는 Cookie 헤더를 받지 않는다 (BE e2e — access 만료 후 가장 흔한 상태)
28. `X-CSRF-Protection`이 agent에 같은 값으로 도달한다 (BE e2e)
29. app 경로의 Cookie는 재작성되지 않는다 — `/api/v1/auth/refresh`에 두 토큰이 모두 도달한다 (BE e2e — 회귀 가드: refresh가 계속 돈다)

**에이전트가 없어도 BE는 선다**

30. agent 컨테이너가 없는 망에서 nginx가 기동한다 (BE e2e — 회귀 가드: 정적 해석이면 기동하지 못한다, 실측)
31. 그 상태에서 app 경로가 응답한다 (BE e2e — 회귀 가드)
32. 그 상태에서 에이전트 경로는 502다 (BE e2e)
33. agent가 나중에 뜨면 nginx 재시작 없이 에이전트 경로가 agent에 도달한다 (BE e2e — 요청 시점 해석)

**운영 구성이 원칙을 구조로 지킨다**

34. `agent` 서비스는 `cure-proxy` 망에만 붙는다 — `cure-backend`에 없다 (BE e2e — compose 파싱)
35. `agent` 환경에 `DATABASE_URL`·`REDIS_URL`이 없다 (BE e2e — compose 파싱)
36. `agent` 환경의 `BE_ORIGIN`이 `http://app:3000`이다 (BE e2e — compose 파싱)
37. `agent` 환경에 `AGENT_TRACING_ENABLED`·`LANGSMITH_*`·`LANGCHAIN_*` 키가 없다 (BE e2e — compose 파싱: 운영 추적 통로는 이 스텝에서 열지 않는다)
38. `agent` healthcheck가 `/api/v1/agent/healthz`를 본다 (BE e2e — compose 파싱)
39. `nginx.depends_on`에 `agent`가 없다 (BE e2e — compose 파싱: 기동 순서로도 결합하지 않는다)

fixture 규약: AGENT 유닛은 **실제 BE를 부르지 않는다** — 받은 요청을 기록하는 fake BE(HTTP 전송 치환)로
헤더·상태를 단언하고, BE 응답은 `GET /auth/me`의 `ClinicianResponseDto` **구조를 모방한 합성 값**이다. 추적
단언은 네트워크 없이 LangChain 콜백 구성에 트레이서가 붙는지로만 보고, 엔드포인트는 닿지 않는 주소로 둔다(실측
조사와 같은 방법). BE e2e는 **운영 `nginx/conf.d/api.conf`를 사본 없이 마운트한다** — 사본으로 통과하면 운영
설정을 검증한 것이 아니다. stub `app`·`agent`는 받은 Cookie·CSRF 헤더를 본문으로 되돌려주는 컨테이너이고,
TLS 인증서는 테스트가 실행 시 만든 더미를 마운트한다(커밋하지 않는다 — 개인키는 gitleaks에 걸린다. `nginx:alpine`에는
openssl이 없어 엔트리포인트의 더미 발급은 패키지 설치에 기댄다). compose 기준은 `docker/gcp/compose.yml`을
파싱하며 컨테이너를 띄우지 않는다. **이 문서의 운영 수치(1,378MiB·108MiB·271MB·12초)는 환경의 성질이라
단언 대상이 아니다** — 동결하는 것은 전달 규칙·경로 분기·격리·구성 불변식이다.

## Out of scope

- **라우팅(5분류)·환자·재고 경로** — 이 경로 위에 얹는다. 논의된 방향(RAG는 BE 파이프라인을 도구로 재사용,
  환자·재고·복합의 최종 응답 합성은 에이전트, 저장은 BE API)은 해당 스펙이 확정한다.
- **대화 저장 계약** — 에이전트 대화도 채팅 DB에 남아야 하고 쓰는 쪽은 BE뿐이다. 기록 API는 BE의 새 계약이다.
- **실행 도중 access 만료 대책**(위험 ⑴) — 시작 시 남은 수명 확인, 사용자 메시지 선저장 등. BE를 여러 번
  부르는 첫 스텝이 정한다.
- **LLM 호출 전 인증 확인** — 비로그인 요청이 분류 LLM으로 비용을 태우지 못하게 한다. 에이전트의 BE 선확인과
  nginx `auth_request` 중 첫 LLM 스텝이 고른다.
- **환자 경로 LangSmith 입출력 숨김과 운영 추적 통로** — 둘을 같은 스텝에서 연다(판단 근거 「추적 스위치」).
- **에이전트 API의 FE 계약·화면** — OpenAPI 병합·codegen 경로와 함께, FE가 에이전트를 처음 소비하는 스텝에서.
- **refresh 쿠키 Path 축소** — 모든 비인증 경로에 이득이지만 인증 정책 변경이라 별건이다.
- **API 게이트웨이·토큰 교환** — 인증을 위임받는 서비스가 늘거나, 실행이 access 수명을 넘거나, 사용자 단위
  요청 제한이 필요해질 때 재검토한다.
- **교차 레포 자동 배포 트리거** — 에이전트 단독 배포는 dispatch로 충분하다.
- **에이전트↔BE traceId 연결** — BE는 수신 헤더를 읽지 않고 요청마다 새 ULID를 만든다(`context.module.ts:14-15`).
- **에이전트 메트릭·알림 규칙** — 기능이 생긴 뒤에 무엇을 셀지 정한다.
- **medical-agentic-rag 구현 하네스 이식** — 스펙 없이 한다(BE도 §15 구현 순서 4단계에서 그렇게 했다). AGENT
  기준의 동결은 이식 뒤에 가능하다.
- **기존 실험 코드(`/ask`·evals·psycopg 검색)의 처분** — 서비스 앱에 싣지 않을 뿐 지우지 않는다.
