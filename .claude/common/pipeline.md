# /pipeline — 배포 파이프라인 (Claude Code 어댑터)

이 파일은 하네스 중립 배포 파이프라인의 **Claude Code 진입점**이다. **절차·체크리스트·원칙의 전문은 `automation/pipeline.md`에 있다** — 아래에서 참조하는 모든 섹션(「폴링 실행 규칙」, 「환경변수 추가 체크리스트」, 「파괴적 DB 마이그레이션 2단계 배포 원칙」, 「민감 파일 커밋 금지」, Step 1~4, 실패 시 재시작 규칙 등)은 `automation/pipeline.md`의 동명 섹션을 가리킨다.

## 실행

`automation/pipeline.md`를 읽고 Step 1부터 실행한다.

## Claude Code 하네스 설정 (원본 명세에 주입)

- **폴링 모드**: CI/CD·PR 체크 대기는 `automation/bin/`의 폴링 스크립트(`pr-gate.sh`·`run-wait.sh`)를 **`run_in_background: true` Bash**로 실행한다 (포그라운드 `sleep` 차단, Monitor 도구 금지 — 단일 완료 대기에 부적합). 메인 세션이 직접 수행하고 서브에이전트에 위임하지 않는다. 스크립트 완료 시 세션이 자동 재호출된다. (`automation/pipeline.md` 「폴링 실행 규칙」의 Claude Code 모드)
- **Co-Author 트레일러**: `automation/pipeline.md` Step 1 커밋 메시지 끝에 `Co-Authored-By: Claude Code <noreply@anthropic.com>`를 붙인다.
- **안전 규칙**: 「민감 파일 커밋 금지」는 커밋 전 `automation/bin/sensitive-gate.sh` 실행으로 기계 검사하고, PreToolUse 훅(`.claude/hooks/validate-git-sensitive.sh`)이 추가로 자동 차단한다 — 이중 방어로 작동한다.
