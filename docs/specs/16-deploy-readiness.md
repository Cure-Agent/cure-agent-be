# 16. 배포 인프라 — 컨테이너 이미지 + Readiness

> 백로그 마지막 항목. spec 12에서 로컬 인프라(compose로 pg·redis)만 갖췄고 **앱 이미지가 없어 배포 자체가 불가**했다.

## 목표

앱을 컨테이너로 배포할 수 있게 하고, **의존성이 준비된 인스턴스에만 트래픽이 가도록** readiness를 제공한다.

현재 `/health`는 프로세스가 살아 있으면 무조건 `ok`다. 배포·재기동 직후 DB·Redis 연결이 아직 안 된 인스턴스도
"정상"으로 보고되어 그대로 트래픽을 받는다.

## 범위

| 대상 | 변경 |
|---|---|
| `GET /api/v1/health` | **변경 없음**(liveness — 프로세스 생존만 본다) |
| `GET /api/v1/health/ready` | **신규** — DB `SELECT 1` + Redis `PING` 확인 |
| 에러코드 | `SERVICE_NOT_READY`(503) 신설 — 레지스트리 + architecture.md §10.2 같은 커밋에서 갱신 |
| `Dockerfile` | 신규 — multi-stage(deps→build→runtime), 비-root 실행, `node dist/main` |
| `docker-compose.yml` | `app` 서비스 추가(profile `app` — 기본 기동은 지금처럼 pg·redis만) |
| CI | `docker-build` job 추가 — 이미지가 실제로 빌드되는지 검증 |

**liveness와 readiness를 구분하는 이유**: Redis는 서비스 전반에서 fail-open이라 장애 중에도 앱은 계속 동작해야 한다
(→ liveness 200 유지, 재시작되지 않음). 반면 readiness는 "이 인스턴스에 트래픽을 보내도 되는가"라 의존성이
끊기면 not-ready(503)로 빼는 것이 맞다. 두 신호를 같은 엔드포인트로 합치면 Redis 장애가 전 인스턴스 재시작 루프가 된다.

## 계약 변경

`/health/ready`가 OpenAPI에 추가된다 → `pnpm openapi:export` 결과를 같은 커밋에 포함하고,
머지 후 FE `contract-sync` 자동 PR까지 확인한다(§1).

응답(성공): `data = { status: 'ready', dependencies: { database: 'up', redis: 'up' } }`
응답(실패): 503, 루트 `code = 'SERVICE_NOT_READY'`, `data = { database: 'up' | 'down', redis: 'up' | 'down' }`

## 수용 기준 (= 동결 시나리오)

**유닛**

1. DB·Redis 모두 정상 → `{ status: 'ready', dependencies: { database: 'up', redis: 'up' } }` 반환, 예외 없음
2. DB 조회가 throw → `ServiceException('SERVICE_NOT_READY')`이고 `data`가 `{ database: 'down', redis: 'up' }`
3. Redis ping이 throw → `ServiceException('SERVICE_NOT_READY')`이고 `data`가 `{ database: 'up', redis: 'down' }`
4. 둘 다 throw → `data`가 `{ database: 'down', redis: 'down' }`

**e2e**

5. `GET /api/v1/health` → 200, 봉투 `data.status === 'ok'` (인증 없이 — 기존 계약 회귀 보호)
6. `GET /api/v1/health/ready` → 200, 봉투 `data.status === 'ready'`,
   `data.dependencies.database === 'up'`, `data.dependencies.redis === 'up'` (컨테이너 둘 다 가동 중)

## Out of scope

- k8s 매니페스트·헬름 차트, 이미지 레지스트리 푸시(자격증명 필요), 오토스케일·롤아웃 정책
- Prometheus `/metrics`(§14에서 P1), 로그 수집기 연동
- readiness 캐싱·타임아웃 튜닝(현재는 매 호출 확인)
