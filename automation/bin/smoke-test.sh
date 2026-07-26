#!/usr/bin/env bash
# automation/bin 게이트 스크립트 스모크 테스트 — CI(scripts 잡)와 로컬에서 동일하게 실행한다.
# 핵심 검증 대상 둘: (1) fail-closed 성질 — git 조회 실패가 통과(PASS)로 새지 않고
# ERROR(비 0 종료)로 끝나는지, (2) pr-gate.jq 판정 로직 — fixture JSON으로 게이트 규칙
# (전수 검사, 앵커 존재 필수, vacuous pass 방지)을 검증한다.
# gradle·gh 호출이 필요 없는 경로만 검사한다. 의존성은 git·jq뿐이다(둘 다 ubuntu 러너 기본 설치).
# 종료 마커: SMOKE result=PASS|FAIL
set -u

BIN=$(cd "$(dirname "$0")" && pwd) || exit 1
command -v jq >/dev/null 2>&1 \
  || { echo "jq가 필요합니다 (pr-gate 판정 테스트)"; echo "SMOKE result=FAIL"; exit 1; }
FAILED=0

# check <설명> <기대 종료코드> <기대 마커> <명령...>
check() {
  local desc=$1 want_rc=$2 want_marker=$3
  shift 3
  local out rc
  out=$("$@" 2>&1)
  rc=$?
  if [ "$rc" -ne "$want_rc" ] || ! grep -q "$want_marker" <<<"$out"; then
    echo "FAIL: $desc (rc=$rc, 기대 rc=$want_rc, 기대 마커 '$want_marker')"
    # 여러 줄 들여쓰기는 sed가 더 명확하다
    # shellcheck disable=SC2001
    sed 's/^/  | /' <<<"$out"
    FAILED=1
  else
    echo "ok: $desc"
  fi
}

# 스크래치 리포 — 사용자 리포의 인덱스·워킹트리를 건드리지 않는다.
TMP=$(mktemp -d) || exit 1
trap 'rm -rf "$TMP"' EXIT
git -C "$TMP" init -q
cd "$TMP" || exit 1

check "sensitive-gate: 민감 파일 없음 → PASS" \
  0 "SENSITIVE_GATE result=PASS" "$BIN/sensitive-gate.sh"
echo secret > .env
git add -f .env
check "sensitive-gate: .env 스테이징 → BLOCKED" \
  1 "SENSITIVE_GATE result=BLOCKED" "$BIN/sensitive-gate.sh"
git reset -q -- .env && rm .env
echo key > AuthKey_test.p8
git add -f AuthKey_test.p8
check "sensitive-gate: *.p8 스테이징 → BLOCKED" \
  1 "SENSITIVE_GATE result=BLOCKED" "$BIN/sensitive-gate.sh"
git reset -q -- AuthKey_test.p8 && rm AuthKey_test.p8
echo tf > terraform.tfstate.backup
git add -f terraform.tfstate.backup
check "sensitive-gate: *.tfstate.backup 스테이징 → BLOCKED" \
  1 "SENSITIVE_GATE result=BLOCKED" "$BIN/sensitive-gate.sh"
git reset -q -- terraform.tfstate.backup && rm terraform.tfstate.backup
check "sensitive-gate: git 실패 → ERROR (fail-closed)" \
  1 "SENSITIVE_GATE result=ERROR" env GIT_DIR=/nonexistent "$BIN/sensitive-gate.sh"

# --- pr-gate.jq 판정 fixture 테스트 (gh 없이 게이트 규칙 자체를 검증)
GATE_JQ="$BIN/pr-gate.jq"
CI_OK='{"__typename":"CheckRun","name":"ci","status":"COMPLETED","conclusion":"SUCCESS"}'
SONAR_OK='{"__typename":"CheckRun","name":"SonarCloud Code Analysis","status":"COMPLETED","conclusion":"SUCCESS"}'

printf '{"mergeable":"MERGEABLE","statusCheckRollup":[%s,%s]}' \
  "$CI_OK" "$SONAR_OK" > fixture.json
check "pr-gate.jq: 전부 성공 → PASS" \
  0 "^PASS$" jq -r -f "$GATE_JQ" fixture.json --args ci

printf '{"mergeable":"MERGEABLE","statusCheckRollup":[{"__typename":"CheckRun","name":"ci","status":"COMPLETED","conclusion":"FAILURE"},%s]}' \
  "$SONAR_OK" > fixture.json
check "pr-gate.jq: 앵커 체크 실패 → FAIL" \
  0 "^FAIL failed=ci" jq -r -f "$GATE_JQ" fixture.json --args ci

printf '{"mergeable":"MERGEABLE","statusCheckRollup":[%s,{"__typename":"CheckRun","name":"SonarCloud Code Analysis","status":"COMPLETED","conclusion":"FAILURE"}]}' \
  "$CI_OK" > fixture.json
check "pr-gate.jq: 비앵커 체크 실패도 차단 (전수 검사) → FAIL" \
  0 "^FAIL failed=SonarCloud" jq -r -f "$GATE_JQ" fixture.json --args ci

printf '{"mergeable":"MERGEABLE","statusCheckRollup":[%s]}' \
  "$SONAR_OK" > fixture.json
check "pr-gate.jq: 앵커 부재 → PENDING (vacuous pass 방지)" \
  0 "^PENDING anchors_absent=ci" jq -r -f "$GATE_JQ" fixture.json --args ci

printf '{"mergeable":"CONFLICTING","statusCheckRollup":[%s,%s]}' \
  "$CI_OK" "$SONAR_OK" > fixture.json
check "pr-gate.jq: 충돌 → FAIL mergeable=CONFLICTING" \
  0 "mergeable=CONFLICTING" jq -r -f "$GATE_JQ" fixture.json --args ci

printf '{"mergeable":"MERGEABLE","statusCheckRollup":[]}' > fixture.json
check "pr-gate.jq: 체크 0개 → PENDING (vacuous pass 방지)" \
  0 "^PENDING" jq -r -f "$GATE_JQ" fixture.json --args ci

check "pr-gate.sh: 인자 부족 → usage 에러" \
  2 "usage" "$BIN/pr-gate.sh" 1 600
check "run-wait.sh: 인자 부족 → usage 에러" \
  2 "usage" "$BIN/run-wait.sh" ci-ghcr.yml dev

if [ "$FAILED" -ne 0 ]; then
  echo "SMOKE result=FAIL"
  exit 1
fi
echo "SMOKE result=PASS"
