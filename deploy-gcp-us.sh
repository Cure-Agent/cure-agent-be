#!/usr/bin/env bash
set -euo pipefail

# -----------------------------
# Config — GCP 무료 등급(e2-micro) 단일 서버 배포 — deploy.sh(서울)의 사본
# -----------------------------
# 체험 종료에 대비한 병행 환경이다(terraform/gcp-us/README.md). 전환 전까지 서울 배포 경로
# (cd-gcp.yml → deploy.sh)를 건드리지 않으려고 고치지 않고 복사했다 — 병행 기간에 deploy.sh를
# 고치면 여기에도 옮긴다(`diff deploy.sh deploy-gcp-us.sh`).
#
# deploy.sh와의 차이는 모니터링 스택이 없다는 것 하나다(docker/gcp-us/compose.yml). 아래 단계를
# **일부러** 뺐으니 diff에 보여도 되살리지 않는다 — grafana 재시작은 서비스가 없으면 실패해
# set -e가 배포를 멈춘다:
#   - grafana 재시작(프로비저닝 재적용)
#   - 설정 재적재 ⑴의 grafana.conf·prometheus·alertmanager·alloy·loki 항목과 그 검증기
#   - 설정 재적재 ⑵ Prometheus 알림 규칙 SIGHUP
#
# 레포 루트에 있어야 한다 — 자기 디렉토리로 cd한 뒤 docker/·nginx/를 상대 경로로 찾는다.
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-docker/gcp-us/compose.yml}"
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
# nginx upstream 재해석 — app 재생성으로 바뀐 IP를 반영한다 (#463)
# -----------------------------
# nginx의 `location /`은 **정적** `proxy_pass http://app:3000`이라 기동 시점에 해석한 IP를 영구
# 캐시한다(에이전트 경로만 resolver + 변수로 요청 시점에 푼다 — docs/specs/49). 그런데 아래
# `up -d --force-recreate app`은 **매 배포** app을 재생성하고, compose는 컨테이너를 병렬로 지우고
# 다시 만들므로 같은 망(cure-proxy)의 app·agent가 IP를 주고받는다(로컬 실측: 컨테이너 추가 없이
# `--force-recreate app agent` 20회 중 13회 교환). 그러면 nginx는 옛 IP로 붙어 **BE 전 경로가 502**다.
# 2026-09-12 배포에서 실제로 났고(upstream이 alloy였다) `nginx -s reload` 한 줄로 복구됐다.
#
# 이 단계가 없으면 아무도 모른다: `wait_healthy`는 컨테이너 안 127.0.0.1을 보고 alloy는 app을
# 직접 긁으므로(둘 다 nginx를 지나지 않는다) 배포는 성공으로 끝나고 `up{cure-app}`도 1을 유지한다.
#
# 재시작이 아니라 reload인 이유는 무중단이기 때문이다. conf 마운트가 아직 옛 inode일 수 있으나
# 그건 뒤의 「설정 재적재 ⑴」이 재시작으로 처리하며, 여기서 옛 conf를 다시 읽어도 **해석되는 IP는
# 새것**이라 목적을 달성한다. 두 단계가 겹쳐도 무해하다.
# `nginx -t`로 먼저 막는 이유: 문법이 깨진 상태에서 reload하면 nginx가 옛 설정을 유지한 채 살아남아
# 조용히 실패한다 — 그러면 IP도 낡은 채로 남는다.
#
# **호출 지점이 둘인 이유**: app은 정상 경로에서 한 번, 롤백 경로에서 또 한 번 재생성된다. 롤백에서
# 부르지 않으면 되돌린 app이 healthy인데도 에지가 계속 502다 — 장애가 진행 중인 바로 그 순간에.
# 롤백 경로는 `lenient`로 부른다: 이미 실패로 끝날 배포라 reload 실패가 **원래 실패 사유를 덮지**
# 않아야 한다.
reload_nginx() {
  local mode="${1:-strict}"
  if ! docker inspect "$NGINX_CONTAINER" >/dev/null 2>&1; then
    echo "[deploy] WARN: $NGINX_CONTAINER not found — skipping nginx reload" >&2
    return 0
  fi

  echo "[deploy] reloading nginx to re-resolve app upstream..."
  if ! docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1; then
    echo "[deploy] ERROR: nginx config test failed — not reloading (edge may serve a stale upstream)" >&2
    docker exec "$NGINX_CONTAINER" nginx -t || true
    if [[ "$mode" == "strict" ]]; then
      return 1
    fi
    return 0
  fi

  if ! docker exec "$NGINX_CONTAINER" nginx -s reload; then
    echo "[deploy] ERROR: nginx reload failed — the edge may still proxy to the old app IP" >&2
    if [[ "$mode" == "strict" ]]; then
      return 1
    fi
    return 0
  fi

  echo "[deploy] nginx reloaded"
  return 0
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

# (grafana 재시작 없음 — 모니터링 스택이 없다. 머리말 참조)

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

    # 롤백도 app을 재생성했으므로 nginx가 다시 해석해야 한다 — 그러지 않으면 되돌린 app이
    # healthy인데도 에지가 계속 502다. 배포는 어차피 실패로 끝나므로 실패 사유를 덮지 않게 lenient다.
    reload_nginx lenient || true
  else
    echo "[deploy] no previous tag found, skipping rollback" >&2
  fi

  exit 1
fi

# 배포 성공: 현재 태그를 롤백 대상으로 확정 저장
echo "${APP_IMAGE_TAG:-latest}" > "$ROLLBACK_TAG_FILE"
echo "[deploy] updated rollback tag to: ${APP_IMAGE_TAG:-latest}"

# app이 방금 재생성됐으므로 nginx가 upstream을 다시 해석해야 한다 (#463 — 정의는 위 reload_nginx).
# 여기는 strict다: 에지가 낡은 IP를 물고 있으면 그 배포는 성공이 아니다.
if ! reload_nginx; then
  exit 1
fi

# -----------------------------
# 설정 재적재 ⑴ 파일 단위 마운트 — 실행 중 설정이 배포된 파일과 다른 컨테이너만 검증 후 재시작
# (docs/specs/49 · #449)
# -----------------------------
# 파일 단위 bind mount는 CD의 scp가 tar 추출로 파일을 새 inode로 다시 만들면 컨테이너가 옛 inode를
# 계속 본다 — reload로는 반영되지 않고(nginx 엔트리포인트의 12시간 주기 포함), compose도 파일 내용
# 변화를 재생성 사유로 보지 않는다. 컨테이너를 다시 시작해야 마운트가 새 파일로 잡힌다. 운영 실측
# (2026-09-12): nginx는 #443의 재시작 단계로 일치했지만 prometheus·alertmanager·alloy·loki는 07-26
# 기동 이후 전부 옛 inode를 보고 있었다. 매 배포 재시작은 불필요한 단절이므로 달라졌을 때만 한다.
#
# 비교는 반드시 **컨테이너 시야**로 한다. `docker cp`는 bind mount를 호스트 원본으로 해석해 언제나
# "같다"고 답하므로 이 드리프트를 감지하지 못한다(운영 호스트 실측: exec=OLD, cp=NEW).
#   ① docker exec cat — 권한이 필요 없다. cure-loki는 이미지에 sh·cat이 없어 실패한다
#   ② sudo -n cat /proc/<pid>/root<경로> — 컨테이너의 마운트 네임스페이스를 호스트에서 읽는다.
#      컨테이너 안 바이너리가 필요 없어 셸 없는 이미지에도 통한다
# 둘 다 실패하면 판단 근거가 없으므로 **재시작하지 않고 경고만 남긴다** — 근거 없는 재시작은 멀쩡한
# 컨테이너를 매 배포 끊는다.
config_differs() {
  local container="$1" cpath="$2" hpath="$3"
  local tmp pid
  tmp=$(mktemp)
  if ! docker exec "$container" cat "$cpath" >"$tmp" 2>/dev/null; then
    pid=$(docker inspect -f '{{.State.Pid}}' "$container" 2>/dev/null || true)
    # shellcheck disable=SC2024  # 리다이렉트 대상은 mktemp가 만든 배포 계정 소유 파일이라 권한이 필요 없다 —
    # sudo가 필요한 쪽은 /proc/<pid>/root 읽기다
    if [[ -z "$pid" || "$pid" == "0" ]] || ! sudo -n cat "/proc/$pid/root$cpath" >"$tmp" 2>/dev/null; then
      rm -f "$tmp"
      echo "[deploy] WARN: cannot read $cpath from $container — skipping its restart decision" >&2
      return 1
    fi
  fi
  if cmp -s "$tmp" "$hpath"; then
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
  return 0
}

# 새 설정을 **일회용 컨테이너**(같은 이미지·마운트)에서 검증한다 — 깨진 설정으로 재시작하면 그 컨테이너가
# 뜨지 못한다. nginx는 BE까지 전면 장애고, 나머지는 조용한 관측 공백이다(alertmanager가 crash loop인데
# app 헬스만 봐서 배포가 성공으로 지나간 전례가 있다). `-T`가 stdin을 가져가지 않도록 전부 </dev/null로 막는다.
validate_config() {
  case "$1" in
    nginx)
      $DC -f "$COMPOSE_FILE" run --rm -T --no-deps --entrypoint nginx nginx -t </dev/null
      ;;
    *)
      echo "[deploy] ERROR: no validator defined for service: $1" >&2
      return 1
      ;;
  esac
}

# 컨테이너 | 컨테이너 안 경로 | 호스트 파일(APP_DIR 기준) | compose 서비스
# (grafana.conf·모니터링 4종 항목 없음 — 머리말 참조)
CONFIG_MOUNTS=(
  "${NGINX_CONTAINER}|/etc/nginx/conf.d/default.conf|nginx/conf.d/api.conf|nginx"
)

echo "[deploy] checking mounted config drift..."
CHANGED_SERVICES=""
for entry in "${CONFIG_MOUNTS[@]}"; do
  IFS='|' read -r cm_container cm_cpath cm_hpath cm_service <<<"$entry"
  if config_differs "$cm_container" "$cm_cpath" "$cm_hpath"; then
    echo "[deploy] config changed: $cm_hpath ($cm_container)"
    case " $CHANGED_SERVICES " in
      *" $cm_service "*) ;;
      *) CHANGED_SERVICES="$CHANGED_SERVICES $cm_service" ;;
    esac
  fi
done

if [[ -n "${CHANGED_SERVICES// /}" ]]; then
  for svc in $CHANGED_SERVICES; do
    echo "[deploy] validating new config for $svc..."
    if ! validate_config "$svc"; then
      echo "[deploy] ERROR: new $svc config failed validation — $svc keeps serving the old config" >&2
      exit 1
    fi
    echo "[deploy] restarting $svc to remount the changed config..."
    $DC -f "$COMPOSE_FILE" restart "$svc"
  done
else
  echo "[deploy] all mounted configs unchanged — no restart"
fi

# -----------------------------
# 설정 재적재 ⑵ Prometheus 알림 규칙 (#449) — 없음: 모니터링 스택이 없다(머리말 참조)
# -----------------------------

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
