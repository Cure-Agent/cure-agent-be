#!/usr/bin/env bash
#
# Claude Code PreToolUse hook: git 명령에서 민감 파일 감지 시 차단
#
# 설계 노트:
# - 위협 모델은 '악의적 우회'가 아니라 'LLM의 부주의한 커밋'이다.
#   deny는 민감 파일이 실제로 존재할 때만 발동하므로, 명령 감지의
#   false positive 비용은 '검사 한 번 더 도는 것'뿐이다.
# - 이 hook은 1차 방어선이다. .gitignore + GitHub push protection +
#   CI 단 gitleaks와 병행하는 것을 전제로 한다.
#
set -e

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# git 호출 지점 매칭: 명령 시작 / && ; | 체인 / 서브셸 / command 프리픽스,
# git -C <dir>, --git-dir, --work-tree, -c key=val 글로벌 옵션 허용
GIT_PREFIX='(^|[;&|(`]|\$\()[[:space:]]*(command[[:space:]]+)?git([[:space:]]+(-C[[:space:]]+[^[:space:]]+|--git-dir(=[^[:space:]]+)?|--work-tree(=[^[:space:]]+)?|-c[[:space:]]+[^[:space:]]+))*[[:space:]]+'

has_git_sub() { echo "$COMMAND" | grep -qE "${GIT_PREFIX}$1\b"; }

if ! has_git_sub '(add|commit|push)'; then
  exit 0
fi

# 패턴 원천은 automation/bin/sensitive-gate.sh의 정규식 — 변경 시 함께 갱신한다.
SENSITIVE_PATTERNS=(
  ".claude/settings.local.json"
  ".env"
  "application-secret.yml"
  "firebase-adminsdk*.json"
  "*.tfvars"
  "*.tfstate"
  "*.pem"
  "*.p12"
  "*.p8"
  "*.key"
  "id_rsa*"
)

BLOCKED_FILES=()

matches_sensitive() {
  local file="$1" pattern base
  base=$(basename "$file")
  # *.example은 플레이스홀더 템플릿이라 커밋 허용 — sensitive-gate.sh의 예외와 정합
  case "$base" in
    *.example) return ;;
  esac
  for pattern in "${SENSITIVE_PATTERNS[@]}"; do
    # 패턴의 glob 매칭(*.pem 등)이 의도이므로 case 패턴을 따옴표로 감싸지 않는다
    # shellcheck disable=SC2254
    case "$file" in
      $pattern|*/$pattern) BLOCKED_FILES+=("$file"); return ;;
    esac
    # .env.prod 같은 확장 변형 (basename 기준)
    # shellcheck disable=SC2254
    case "$base" in
      $pattern|${pattern}.*) BLOCKED_FILES+=("$file"); return ;;
    esac
  done
}

check_file_list() {
  # 주의: 반드시 `check_file_list < <(...)` 형태로 호출할 것.
  # `... | check_file_list`는 서브셸에서 실행되어 BLOCKED_FILES 변경이 유실된다.
  while IFS= read -r file; do
    [ -n "$file" ] && matches_sensitive "$file"
  done
}

# ── git add: 추가 후보 파일 검사 ──
if has_git_sub 'add'; then
  ADD_ARGS=$(echo "$COMMAND" | grep -oE "${GIT_PREFIX}add[^;&|]*" | head -1 | sed -E 's/.*\badd[[:space:]]*//')
  # 광역 add(-A/--all/-u/--update/./:\//와일드카드) 또는 인자 없음
  # → 인자 파싱 대신 후보 전체(untracked + tracked modified)를 검사
  if [ -z "$ADD_ARGS" ] || echo "$ADD_ARGS" | grep -qE '(^|[[:space:]])(-A|--all|-u|--update|\.|:/|\*)'; then
    check_file_list < <(git ls-files --others --modified --exclude-standard 2>/dev/null)
  else
    # 인자들을 공백 분리해 줄 단위로 넘기는 것이 의도다
    # shellcheck disable=SC2086
    check_file_list < <(printf '%s\n' $ADD_ARGS)
  fi
fi

# ── git commit: 스테이징 파일 + (-a 계열이면) tracked modified 검사 ──
if has_git_sub 'commit'; then
  check_file_list < <(git diff --cached --name-only 2>/dev/null)
  COMMIT_SEG=$(echo "$COMMAND" | grep -oE "${GIT_PREFIX}commit[^;&|]*" | head -1)
  # -a / -am / --all: 커밋 시점에 tracked modified를 스테이징 → --cached로 안 잡힘
  if echo "$COMMIT_SEG" | grep -qE '[[:space:]](-[a-zA-Z]*a[a-zA-Z]*|--all)\b'; then
    check_file_list < <(git diff --name-only 2>/dev/null)
  fi
fi

# ── git push: 아직 원격에 없는 커밋들에 포함된 파일 검사 ──
# (스테이징 검사는 push 대상이 아니므로 부정확 — 커밋된 파일을 봐야 한다)
if has_git_sub 'push'; then
  check_file_list < <(git log --branches --not --remotes --name-only --pretty=format: -n 300 2>/dev/null | sort -u)
fi

if [ ${#BLOCKED_FILES[@]} -gt 0 ]; then
  FILES_LIST=$(printf '%s\n' "${BLOCKED_FILES[@]}" | sort -u | paste -sd ', ' -)
  jq -n --arg files "$FILES_LIST" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("민감 파일 감지로 차단: " + $files + ". 스테이징 파일은 git reset HEAD <file>로 해제하고, 커밋에 이미 포함됐다면 해당 커밋을 정리한 뒤 재시도하세요.")
    }
  }'
  exit 0
fi

exit 0
