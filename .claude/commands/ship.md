# /ship — 코드 변경 배포 자동화 (Claude Code 어댑터)

이 명령은 하네스 중립 배포 워크플로우의 **Claude Code 진입점**이다. 절차 원본은 `automation/ship.md`(+ `automation/pipeline.md`)에 있다.

## 실행

`automation/ship.md`를 읽고 Preflight → Phase 1~4를 그대로 실행한다. Phase 4에서 `automation/pipeline.md`를 읽어 배포한다.
사용자 인자(예: `/ship feat 알림 설정 API 추가`)는 `automation/ship.md`의 Phase 1 규칙대로 처리한다.

## Claude Code 하네스 설정 (원본 명세에 주입)

- **폴링 모드**: CI/CD·PR 체크 대기는 `automation/bin/`의 폴링 스크립트(`pr-gate.sh`·`run-wait.sh`)를 **`run_in_background: true` Bash**로 실행한다. 포그라운드 `sleep` 차단·Monitor 도구 금지. 스크립트 완료 시 세션이 자동 재호출된다. (`automation/pipeline.md` 「폴링 실행 규칙」의 Claude Code 모드)
- **Co-Author 트레일러**: `automation/pipeline.md` Step 1 커밋 메시지 끝에 `Co-Authored-By: Claude Code <noreply@anthropic.com>`를 붙인다.
- **안전 규칙**: 「민감 파일 커밋 금지」는 커밋 전 `automation/bin/sensitive-gate.sh` 실행으로 기계 검사하고, PreToolUse 훅(`.claude/hooks/validate-git-sensitive.sh`)이 `git add/commit/push`를 추가로 자동 차단한다 — 이중 방어로 작동한다.
