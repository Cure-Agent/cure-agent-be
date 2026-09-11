#!/usr/bin/env bash
set -euo pipefail

# -----------------------------
# Config — GCP 단일 서버 배포 (배포 계획 v2)
# -----------------------------
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-docker/gcp/compose.yml}"
APP_CONTAINER="cure-app"
IMAGE_REPO="ghcr.io/cure-agent/cure-agent-app"
NGINX_CONTAINER="cure-nginx"
# 에이전트 서비스 (docs/specs/49) — 이미지는 medical-agentic-rag CI가 main 머지마다 올린다
AGENT_CONTAINER="cure-agent"
AGENT_IMAGE_REPO="ghcr.io/cure-agent/medical-agentic-rag"

cd "$APP_DIR"

# docker compose / docker-compose 자동 감지
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
else
  DC="docker-compose"
fi

ROLLBACK_TAG_FILE="${APP_DIR}/.previous_image_tag"
AGENT_ROLLBACK_TAG_FILE="${APP_DIR}/.previous_agent_image_tag"

echo "[deploy] dir=$APP_DIR"
echo "[deploy] compose=$COMPOSE_FILE"
echo "[deploy] dc='$DC'"
echo "[deploy] tag=${APP_IMAGE_TAG:-latest}"
echo "[deploy] agent_tag=${AGENT_IMAGE_TAG:-latest}"

# -----------------------------
# Pre-checks
# -----------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "[deploy] ERROR: docker not found" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "[deploy] ERROR: $COMPOSE_FILE not found in $APP_DIR" >&2
  exit 1
fi

# -----------------------------
# 헬스 대기 헬퍼 — compose healthcheck 상태를 본다.
# app은 readiness(DB·Redis 포함), agent는 liveness(프로세스 생존 — BE를 부르지 않는다)다.
# -----------------------------
wait_healthy() {
  local container="$1"
  for _ in $(seq 1 60); do
    STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo "missing")
    if [[ "$STATUS" == "healthy" ]]; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# -----------------------------
# 롤백용 현재 이미지 태그 저장
# -----------------------------
CURRENT_TAG=$($DC -f "$COMPOSE_FILE" images app --format '{{.Tag}}' 2>/dev/null || true)
if [[ -n "$CURRENT_TAG" ]]; then
  echo "[deploy] saving current tag for rollback: $CURRENT_TAG"
  echo "$CURRENT_TAG" > "$ROLLBACK_TAG_FILE"
fi

# 에이전트도 같은 구조로 따로 저장한다 — 두 이미지는 다른 레포에서 다른 주기로 올라온다.
# 태그는 실행 중 컨테이너의 이미지 참조에서 읽는다 — `compose images --format`은 v5에서 table|json만
# 받아 Go 템플릿이 실패한다(로컬 v5.5.1 실측). 첫 배포처럼 컨테이너가 없으면 비어 있고 저장하지 않는다.
CURRENT_AGENT_IMAGE=$(docker inspect --format '{{.Config.Image}}' "$AGENT_CONTAINER" 2>/dev/null || true)
CURRENT_AGENT_TAG="${CURRENT_AGENT_IMAGE##*:}"
if [[ -n "$CURRENT_AGENT_IMAGE" && -n "$CURRENT_AGENT_TAG" ]]; then
  echo "[deploy] saving current agent tag for rollback: $CURRENT_AGENT_TAG"
  echo "$CURRENT_AGENT_TAG" > "$AGENT_ROLLBACK_TAG_FILE"
fi

# -----------------------------
# Deploy
# -----------------------------
echo "[deploy] pulling images..."
# 에이전트 이미지도 여기서 당긴다 — GHCR에 없으면 마이그레이션 전에 멈춘다(docs/specs/49 배포 순서)
$DC -f "$COMPOSE_FILE" pull

# DB 마이그레이션 — 앱 교체 전에 적용한다.
# `run app`이 depends_on(postgres·redis healthy)을 먼저 띄운 뒤 실행된다.
# drizzle-kit은 devDep이라 이미지에 없으므로 drizzle-orm 내장 migrator를 쓴다.
echo "[deploy] running db migration..."
$DC -f "$COMPOSE_FILE" run --rm app node scripts/migrate.mjs

echo "[deploy] starting/updating containers..."
# --remove-orphans: compose 파일에서 사라진 컨테이너 정리
# agent는 강제 재생성하지 않는다 — compose가 설정이나 이미지 digest가 바뀔 때만 재생성한다.
# 매 배포 재생성은 nginx 해석 캐시(valid=10s) 동안 에이전트 경로 502 창을 만든다(docs/specs/49 위험 ⑶).
$DC -f "$COMPOSE_FILE" up -d --remove-orphans
# app은 항상 재생성하여 환경변수/이미지 변경사항 반영 보장
$DC -f "$COMPOSE_FILE" up -d --force-recreate app

# grafana provisioning(datasources.yml)은 bind mount라 파일만 바뀌면
# compose가 컨테이너 재생성 트리거를 잡지 못한다. 게다가 데이터소스 프로비저닝은
# 대시보드(updateIntervalSeconds 주기 리로드)와 달리 부팅 시 1회만 읽으므로,
# 재시작을 강제하지 않으면 uid 변경이 영영 반영되지 않아 대시보드가
# "Datasource ... was not found"로 전부 깨진다.
echo "[deploy] restarting grafana to re-apply provisioning..."
$DC -f "$COMPOSE_FILE" restart grafana

echo "[deploy] current status:"
$DC -f "$COMPOSE_FILE" ps

# -----------------------------
# app Health Check → 실패 시 자동 롤백
# -----------------------------
echo "[deploy] waiting for health check..."
if wait_healthy "$APP_CONTAINER"; then
  echo "[deploy] app is healthy"
else
  echo "[deploy] ERROR: app failed to become healthy within 180s" >&2
  echo "[deploy] app logs:"
  docker logs --tail 50 "$APP_CONTAINER" || true

  # 자동 롤백 시도 (주의: 이미 적용된 마이그레이션은 되돌아가지 않는다 —
  # 파괴적 마이그레이션 2단계 배포 원칙은 automation/pipeline.md 참조)
  if [[ -f "$ROLLBACK_TAG_FILE" ]]; then
    PREV_TAG=$(cat "$ROLLBACK_TAG_FILE")
    echo "[deploy] ROLLING BACK to previous tag: $PREV_TAG"
    export APP_IMAGE_TAG="$PREV_TAG"
    $DC -f "$COMPOSE_FILE" pull app
    $DC -f "$COMPOSE_FILE" up -d --force-recreate app

    if wait_healthy "$APP_CONTAINER"; then
      echo "[deploy] rollback successful, app is healthy on tag: $PREV_TAG"
    else
      echo "[deploy] CRITICAL: rollback to $PREV_TAG also failed!" >&2
    fi
  else
    echo "[deploy] no previous tag found, skipping rollback" >&2
  fi

  exit 1
fi

# 배포 성공: 현재 태그를 롤백 대상으로 확정 저장
echo "${APP_IMAGE_TAG:-latest}" > "$ROLLBACK_TAG_FILE"
echo "[deploy] updated rollback tag to: ${APP_IMAGE_TAG:-latest}"

# -----------------------------
# nginx 설정 반영 — 실행 중 설정이 배포된 파일과 다를 때만 검증 후 재시작 (docs/specs/49)
# -----------------------------
# api.conf·grafana.conf는 **파일 단위 bind mount**다. CD의 scp가 tar 추출로 파일을 새 inode로 다시
# 만들면 실행 중인 nginx는 옛 inode를 계속 본다 — `nginx -s reload`(엔트리포인트의 12시간 주기 포함)로는
# 반영되지 않고, compose도 파일 내용 변화를 재생성 사유로 보지 않는다. 운영 실측(2026-09-12): 09-05에 뜬
# cure-nginx가 09-10 CD 뒤에도 옛 inode를 보고 있었다. 컨테이너를 다시 시작해야 마운트가 새 파일로 잡힌다.
# 매 배포 재시작은 전 경로를 잠깐 끊으므로 내용이 달라졌을 때만 한다.
# 재시작 전에 새 설정을 일회용 컨테이너(같은 볼륨·망)에서 `nginx -t`로 검증한다 — 깨진 설정으로 재시작하면
# nginx가 뜨지 못해 BE까지 전면 장애다. 검증이 실패하면 옛 설정으로 계속 서비스하고 배포를 실패로 끝낸다.
nginx_conf_differs() {
  local src="$1" dst="$2"
  ! docker exec "$NGINX_CONTAINER" cat "$dst" 2>/dev/null | cmp -s - "$src"
}

if nginx_conf_differs nginx/conf.d/api.conf /etc/nginx/conf.d/default.conf \
  || nginx_conf_differs nginx/conf.d/grafana.conf /etc/nginx/conf.d/grafana.conf; then
  echo "[deploy] nginx config changed — validating with nginx -t..."
  if ! $DC -f "$COMPOSE_FILE" run --rm -T --no-deps --entrypoint nginx nginx -t; then
    echo "[deploy] ERROR: new nginx config failed validation — nginx keeps serving the old config" >&2
    exit 1
  fi
  echo "[deploy] restarting nginx to remount the changed config..."
  $DC -f "$COMPOSE_FILE" restart nginx
else
  echo "[deploy] nginx config unchanged — no restart"
fi

# -----------------------------
# agent Health Check → 실패 시 에이전트만 롤백하고 배포는 실패로 끝낸다 (docs/specs/49)
# -----------------------------
# app은 이미 새 태그로 healthy다 — 되돌리지 않는다. 에이전트는 BE를 끌어내리지 않는 부속 서비스지만
# 조용히 성공 처리하지도 않는다: alertmanager가 crash loop인데 app 헬스만 봐서 배포가 성공으로
# 지나간 전례가 있다. 대가로 에이전트 latest가 깨져 있는 동안은 BE 배포도 실패로 끝난다(위험 ⑵).
echo "[deploy] waiting for agent health check..."
if wait_healthy "$AGENT_CONTAINER"; then
  echo "[deploy] agent is healthy"
else
  echo "[deploy] ERROR: agent failed to become healthy within 180s" >&2
  echo "[deploy] agent logs:"
  docker logs --tail 50 "$AGENT_CONTAINER" || true

  if [[ -f "$AGENT_ROLLBACK_TAG_FILE" ]]; then
    PREV_AGENT_TAG=$(cat "$AGENT_ROLLBACK_TAG_FILE")
    echo "[deploy] ROLLING BACK agent to previous tag: $PREV_AGENT_TAG"
    export AGENT_IMAGE_TAG="$PREV_AGENT_TAG"
    $DC -f "$COMPOSE_FILE" pull agent
    $DC -f "$COMPOSE_FILE" up -d --force-recreate agent

    if wait_healthy "$AGENT_CONTAINER"; then
      echo "[deploy] agent rollback successful, agent is healthy on tag: $PREV_AGENT_TAG"
    else
      echo "[deploy] CRITICAL: agent rollback to $PREV_AGENT_TAG also failed!" >&2
    fi
  else
    echo "[deploy] no previous agent tag found, skipping agent rollback" >&2
  fi

  exit 1
fi

echo "${AGENT_IMAGE_TAG:-latest}" > "$AGENT_ROLLBACK_TAG_FILE"
echo "[deploy] updated agent rollback tag to: ${AGENT_IMAGE_TAG:-latest}"

# 찌꺼기 이미지 정리(실패해도 배포 성공에는 영향 없게)
echo "[deploy] pruning dangling images..."
docker image prune -f >/dev/null 2>&1 || true

# 사용 중이지 않은 오래된 앱·에이전트 이미지 정리
echo "[deploy] cleaning up old app/agent images..."
RUNNING_IMAGES=$(docker ps --format '{{.Image}}' | sort -u)
for repo in "$IMAGE_REPO" "$AGENT_IMAGE_REPO"; do
  docker images "$repo" --format '{{.Repository}}:{{.Tag}}' \
    | while read -r img; do
        if ! echo "$RUNNING_IMAGES" | grep -qF "$img"; then
          echo "[deploy] removing unused image: $img"
          docker rmi "$img" 2>/dev/null || true
        fi
      done
done

# containerd 이미지 스토어 잔재 정리
# Docker 29는 pull한 레이어를 containerd content store에도 남기는데, daemon.json의
# containerd-snapshotter=false(overlay2 모드)에서는 그걸 실행에 쓰지 않는다. 즉 이미지가
# /var/lib/docker/overlay2와 /var/lib/containerd에 이중 저장된다.
# 참조가 끊긴 blob만 회수한다 — 실행 중 컨테이너 rootfs는 overlay2라 영향받지 않는다.
echo "[deploy] pruning containerd orphan content..."
sudo -n ctr -n moby content prune references >/dev/null 2>&1 || true

# -----------------------------
# 디스크 현황 로깅 — 잔재 누적을 배포 로그에서 조기에 감지한다.
# 2026-07-27에 snapshotter 전환(overlay2 복귀) 잔재 3.7GB가 뒤늦게 발견된 적이 있다.
# -----------------------------
echo "[deploy] disk usage:"
df -h / | tail -1
CONTAINERD_SIZE=$(sudo -n du -sh /var/lib/containerd 2>/dev/null | awk '{print $1}' || echo "n/a")
echo "[deploy] /var/lib/containerd: $CONTAINERD_SIZE (overlay2 모드에서는 수 MB가 정상 — GB 단위면 잔재를 의심할 것)"
docker system df 2>/dev/null || true

echo "[deploy] done"
