#!/usr/bin/env bash
# e2-micro(1GB·지속 CPU 0.25개분) OS 정리 — 이 서버가 쓰지 않는 상주 데몬과 한국 낮에 도는 유지보수 작업을 걷어낸다.
#
# 근거는 2026-10-14 실측이다(terraform/gcp-us/README.md 「OS 정리」):
#   - apt-daily-upgrade가 06:53 UTC(한국 15:53)에 돌아 패키지 4개에 12분이 걸렸다. 그동안 가용 메모리 212MiB,
#     10초에 87MiB 재읽기, 외부 헬스 응답 15.7초였고, 뒤이어 man-db 트리거(mandb)가 디스크를 채웠다.
#   - 상주 데몬 중 쓰지 않는 것이 RSS 합 ≈90MiB였다: multipathd 27MiB(mlock)·packagekitd 20·snapd 16·
#     networkd-dispatcher 15·google_osconfig_agent 14.
#
# main.tf의 user_data(cloud-init)가 첫 부팅에 이 파일을 실행한다. 이미 떠 있는 VM에는 같은 파일을 한 번 실행한다:
#   ssh deploy@<미국 IP> 'sudo bash -s' < terraform/gcp-us/os-tune.sh
# 여러 번 실행해도 결과가 같다. 단계 하나가 실패해도 나머지는 계속한다(첫 부팅의 Docker 설치를 막지 않게) —
# 실패는 [os-tune] WARN 줄로 남는다.
set -u

log() { echo "[os-tune] $*"; }

# ① 자동 업데이트는 끄지 않고 한국 새벽으로 옮긴다 — 보안 업데이트는 그대로 받는다.
#    기본값은 06:00 UTC ±60분(한국 15~16시)이다. 앱 크론(03:00 KST 파기·04:00 KST 개정 스캔)과 겹치지 않게
#    목록 갱신을 02:00, 설치를 02:30 KST에 둔다.
for spec in apt-daily:02:00 apt-daily-upgrade:02:30; do
  unit="${spec%%:*}"
  at="${spec#*:}"
  mkdir -p "/etc/systemd/system/${unit}.timer.d"
  printf '[Timer]\nOnCalendar=\nOnCalendar=*-*-* %s Asia/Seoul\nRandomizedDelaySec=0\n' "$at" \
    >"/etc/systemd/system/${unit}.timer.d/override.conf"
done
if systemctl daemon-reload && systemctl restart apt-daily.timer apt-daily-upgrade.timer; then
  log "apt timers moved: apt-daily 02:00 KST, apt-daily-upgrade 02:30 KST"
else
  log "WARN: apt timer override not applied"
fi

# ② man 색인 갱신을 끈다 — 매일 도는 타이머와, 패키지를 설치할 때마다 도는 dpkg 트리거 둘 다.
#    트리거는 /var/lib/man-db/auto-update가 있을 때만 돈다. man-db 패키지가 업그레이드되면 debconf 값을 보고
#    그 파일을 다시 만들므로 debconf도 함께 끈다.
# LC_ALL=C: SSH가 넘긴 클라이언트 로케일(macOS의 LC_CTYPE=UTF-8)이 서버에 없으면 perl이 경고를 쏟는다
if echo 'man-db man-db/auto-update boolean false' | LC_ALL=C debconf-set-selections; then
  rm -f /var/lib/man-db/auto-update
  systemctl mask man-db.timer >/dev/null 2>&1
  systemctl stop man-db.timer >/dev/null 2>&1 || true
  log "man-db timer and dpkg trigger off"
else
  log "WARN: man-db auto-update not disabled"
fi

# ③ 쓰지 않는 상주 데몬을 mask한다 — 패키지 업데이트나 D-Bus 활성화로도 다시 뜨지 않는다.
#    multipathd: 다중 경로 장치가 없다(`multipath -ll` 빈 출력).
#    packagekit: apt 훅이 D-Bus로 깨운다. mask해도 훅은 실패를 삼킨다(`; /bin/echo`).
#    networkd-dispatcher: 훅은 chrony 온·오프라인 알림뿐이다. chrony는 알림 없이도 자체 폴링으로 동기화한다.
#    google-osconfig-agent: VM Manager(OS 인벤토리·패치)를 쓰지 않는다.
#    google-guest-agent는 남긴다 — 메타데이터 ssh-keys로 deploy 계정의 키를 심는 주체다.
for unit in multipathd.service multipathd.socket packagekit.service networkd-dispatcher.service google-osconfig-agent.service; do
  if systemctl mask "$unit" >/dev/null 2>&1; then
    systemctl stop "$unit" >/dev/null 2>&1 || true
    log "masked $unit"
  else
    log "WARN: could not mask $unit"
  fi
done

# ④ snapd를 지운다 — 설치된 snap은 core24·snapd·google-cloud-cli(gcloud)뿐이고, 배포는 gcloud를 쓰지 않는다.
#    snapd를 지워도 다른 패키지는 딸려 나가지 않는다(2026-10-14 `apt-get -s purge snapd` 실측).
if dpkg-query -W -f '${Status}' snapd 2>/dev/null | grep -q 'install ok installed'; then
  if DEBIAN_FRONTEND=noninteractive apt-get purge -y snapd >/dev/null 2>&1; then
    log "snapd purged"
  else
    log "WARN: snapd purge failed (apt lock?) — rerun this script later"
  fi
else
  log "snapd already absent"
fi
