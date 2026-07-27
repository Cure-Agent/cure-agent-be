#!/usr/bin/env bash
set -euo pipefail

# -----------------------------
# Config — GCP 단일 서버 배포 (배포 계획 v2)
# -----------------------------
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-docker/gcp/compose.yml}"
APP_CONTAINER="cure-app"
IMAGE_REPO="ghcr.io/cure-agent/cure-agent-app"

cd "$APP_DIR"

# docker compose / docker-compose 자동 감지
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
else
  DC="docker-compose"
fi

ROLLBACK_TAG_FILE="${APP_DIR}/.previous_image_tag"

echo "[deploy] dir=$APP_DIR"
echo "[deploy] compose=$COMPOSE_FILE"
echo "[deploy] dc='$DC'"
echo "[deploy] tag=${APP_IMAGE_TAG:-latest}"

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
# app 헬스 대기 헬퍼 — compose healthcheck(readiness: DB·Redis 포함) 상태를 본다
# -----------------------------
wait_app_healthy() {
  for _ in $(seq 1 60); do
    STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$APP_CONTAINER" 2>/dev/null || echo "missing")
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

# -----------------------------
# Deploy
# -----------------------------
echo "[deploy] pulling images..."
$DC -f "$COMPOSE_FILE" pull

# DB 마이그레이션 — 앱 교체 전에 적용한다.
# `run app`이 depends_on(postgres·redis healthy)을 먼저 띄운 뒤 실행된다.
# drizzle-kit은 devDep이라 이미지에 없으므로 drizzle-orm 내장 migrator를 쓴다.
echo "[deploy] running db migration..."
$DC -f "$COMPOSE_FILE" run --rm app node scripts/migrate.mjs

echo "[deploy] starting/updating containers..."
# --remove-orphans: compose 파일에서 사라진 컨테이너 정리
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
if wait_app_healthy; then
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

    if wait_app_healthy; then
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

# 찌꺼기 이미지 정리(실패해도 배포 성공에는 영향 없게)
echo "[deploy] pruning dangling images..."
docker image prune -f >/dev/null 2>&1 || true

# 사용 중이지 않은 오래된 앱 이미지 정리
echo "[deploy] cleaning up old app images..."
RUNNING_IMAGES=$(docker ps --format '{{.Image}}' | sort -u)
docker images "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}}' \
  | while read -r img; do
      if ! echo "$RUNNING_IMAGES" | grep -qF "$img"; then
        echo "[deploy] removing unused image: $img"
        docker rmi "$img" 2>/dev/null || true
      fi
    done

echo "[deploy] done"
