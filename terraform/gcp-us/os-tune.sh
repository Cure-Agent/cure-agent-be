#!/usr/bin/env bash
# e2-micro(1GB·지속 CPU 0.25개분) OS 정리 — 이 서버가 쓰지 않는 상주 데몬과 한국 낮에 도는 유지보수 작업을 걷어내고,
# 메모리가 넘칠 때 서버 전체가 몇 시간씩 멈추지 않게 한다.
#
# 근거는 2026-10-14 실측(①~④)과 2026-11-06 장애(⑤~⑧)다(terraform/gcp-us/README.md 「OS 정리」):
#   - apt-daily-upgrade가 06:53 UTC(한국 15:53)에 돌아 패키지 4개에 12분이 걸렸다. 그동안 가용 메모리 212MiB,
#     10초에 87MiB 재읽기, 외부 헬스 응답 15.7초였고, 뒤이어 man-db 트리거(mandb)가 디스크를 채웠다.
#   - 상주 데몬 중 쓰지 않는 것이 RSS 합 ≈90MiB였다: multipathd 27MiB(mlock)·packagekitd 20·snapd 16·
#     networkd-dispatcher 15·google_osconfig_agent 14.
#   - 2026-11-06 02:30 KST 자동 업데이트가 메모리를 넘쳐 리셋까지 7.5시간 멈췄다(#561). 스왑이 없어 OOM killer는
#     돌지 않았고(가용 44MB·디스크 %util 93~98%), 그 사이 DHCP 갱신이 실패해 networkd가 네트워크 설정을 지웠다.
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

# ⑤ dpkg를 실행할 때마다 도는 apt-check를 끈다 — update-notifier의 apt 훅(99update-notifier)이 패키지마다 로그인 MOTD의
#    「업데이트 N개」를 다시 센다. apt 캐시를 읽어 42MB를 쓴다(2026-11-06 실측: unattended-upgrade 185MB 위에 얹힌다).
#    update-notifier-common은 ubuntu-server·byobu가 의존하므로 지우지 않는다. 훅이 부르는 스크립트만 dpkg-divert로
#    .distrib에 비켜 두고 빈 스크립트로 바꾼다 — 패키지가 업그레이드돼도 새 판은 .distrib으로 간다. 되돌리기:
#      rm <스크립트> && dpkg-divert --local --rename --remove <스크립트>
motd=/usr/lib/update-notifier/update-motd-updates-available
if [ ! -e "$motd" ] && [ ! -e "$motd.distrib" ]; then
  log "update-notifier hook script absent — skip"
else
  if [ -z "$(dpkg-divert --list "$motd")" ]; then
    dpkg-divert --local --rename --divert "$motd.distrib" --add "$motd" >/dev/null 2>&1
  fi
  if [ -n "$(dpkg-divert --list "$motd")" ]; then
    printf '#!/bin/sh\n# os-tune.sh ⑤ — 원본은 %s.distrib(dpkg-divert)다. apt 훅이 dpkg마다 apt-check를 돌리지 않게 비워 둔다.\nexit 0\n' \
      "$motd" >"$motd"
    chmod 755 "$motd"
    log "apt-check hook off: $motd diverted"
  else
    log "WARN: could not divert $motd (dpkg lock?) — rerun this script later"
  fi
fi

# ⑥ 메모리가 넘쳐 OOM killer가 돌면(⑦) 업데이트가 먼저 죽게 한다 — 업데이트 서비스와 그 자식(unattended-upgrade·dpkg·
#    apt 훅·패키지 관리 스크립트)이 oom_score_adj를 물려받는다. 평소 1순위는 에이전트(uvicorn)·앱(node) 컨테이너다.
#    업데이트가 중간에 죽어도 다음 실행이 끊긴 dpkg를 `dpkg --configure -a`로 마무리한다
#    (Unattended-Upgrade::AutoFixInterruptedDpkg 기본값). esm-cache·apt-news는 apt 훅이 띄우는 별도 유닛이다.
for unit in apt-daily.service apt-daily-upgrade.service esm-cache.service apt-news.service; do
  mkdir -p "/etc/systemd/system/${unit}.d"
  printf '[Service]\nOOMScoreAdjust=1000\n' >"/etc/systemd/system/${unit}.d/oom.conf"
done
if systemctl daemon-reload && [ "$(systemctl show -p OOMScoreAdjust --value apt-daily-upgrade.service)" = 1000 ]; then
  log "apt services OOM-first: OOMScoreAdjust=1000"
else
  log "WARN: apt service OOMScoreAdjust not applied"
fi

# ⑦ 스래싱을 몇 초 안에 끊는다 — 커널 MGLRU의 스래싱 방지(min_ttl_ms, 커널 문서 admin-guide/mm/multigen_lru).
#    스왑이 없으면 메모리가 넘쳐도 OOM killer가 돌지 않는다. 커널은 실행 코드 페이지를 내보내고 다시 읽으며 「진척 중」으로
#    보고, 느린 디스크(≈22 IOPS)에 묶인 채 몇 시간 간다(2026-11-06: 7.5시간, OOM kill 0건).
#    min_ttl_ms=N이면 최근 N ms 안에 쓴 페이지까지 내보내야 할 때 커널이 OOM killer를 부른다. 1000은 문서의 기준값이다.
#    희생자는 oom_score 순이다 — 업데이트 중이면 ⑥의 업데이트, 그 밖엔 가장 큰 컨테이너이고 Docker가 다시 띄운다.
#    sysfs 값은 재부팅하면 사라지므로 tmpfiles.d로 부팅마다 다시 쓴다.
guard=/etc/tmpfiles.d/cure-thrash-guard.conf
printf '# os-tune.sh ⑦ — 최근 1초에 쓴 페이지까지 내보내야 하면 OOM killer를 부른다(MGLRU 스래싱 방지)\nw /sys/kernel/mm/lru_gen/enabled - - - - y\nw /sys/kernel/mm/lru_gen/min_ttl_ms - - - - 1000\n' \
  >"$guard"
if [ -w /sys/kernel/mm/lru_gen/min_ttl_ms ] && systemd-tmpfiles --create "$guard" &&
  [ "$(cat /sys/kernel/mm/lru_gen/min_ttl_ms)" = 1000 ]; then
  log "thrash guard on: lru_gen enabled=$(cat /sys/kernel/mm/lru_gen/enabled) min_ttl_ms=1000"
else
  log "WARN: thrash guard not applied (no MGLRU in this kernel?)"
fi

# ⑧ DHCP 갱신이 실패해도 네트워크 설정을 지우지 않는다 — netplan `critical: true`(networkd KeepConfiguration=true).
#    2026-11-06에는 스래싱 중 DHCP 갱신이 시간 초과로 실패해 networkd가 링크를 Failed로 두고 경로를 지웠다. Failed 링크는
#    다시 시도하지 않으므로 메모리가 회복돼도 외부 패킷이 `martian source`로 버려진다. GCE 내부 IP는 VM 수명 동안 고정이라
#    만료된 리스를 계속 써도 안전하다. cloud-init의 50-cloud-init.yaml과 같은 ID(인터페이스 이름)로 병합되고, dhcp4를
#    함께 적어 혼자 읽혀도 DHCP가 켜진다. 링크를 다시 구성하므로 맨 마지막에 둔다(같은 리스를 다시 받는다).
#    reload까지 성공한 내용은 $applied에 남긴다 — yaml만 보고 건너뛰면 앞선 실행의 generate·reload 실패를 재실행이
#    따라잡지 못한다. 매번 generate하지 않는 것은 netplan이 파일을 새로 쓰면 networkd가 바뀐 것으로 보고 링크를 다시
#    구성하기 때문이다.
iface=$(ip -4 route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
keep=/etc/netplan/99-cure-keep-dhcp.yaml
applied=/var/lib/os-tune/keep-dhcp.applied
if [ -z "$iface" ]; then
  log "WARN: no default route — netplan keep-configuration skipped"
else
  want=$(printf 'network:\n  version: 2\n  ethernets:\n    %s:\n      dhcp4: true\n      critical: true' "$iface")
  if [ "$(cat "$keep" 2>/dev/null)" = "$want" ] && [ "$(cat "$applied" 2>/dev/null)" = "$want" ]; then
    log "netplan keep-configuration already set ($iface)"
  elif (umask 077 && printf '%s\n' "$want" >"$keep") && netplan generate >/dev/null && networkctl reload; then
    mkdir -p "${applied%/*}" && printf '%s\n' "$want" >"$applied"
    sleep 5
    case "$(ip -4 route show default)" in
      *"dev $iface "*) log "netplan keep-configuration on ($iface)" ;;
      *) log "WARN: default route via $iface missing after networkctl reload — check networkctl status $iface" ;;
    esac
  else
    log "WARN: netplan keep-configuration not applied — rerun this script later"
  fi
fi
