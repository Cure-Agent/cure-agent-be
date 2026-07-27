# pipeline — 배포 파이프라인 (하네스 중립 명세)

커밋된 변경사항을 dev PR → CI → main 머지 → CD 배포까지 자동화한다. `/ship`에서 사용한다.
브랜치명에 `#`이 포함되므로 모든 git/gh 명령에서 브랜치명은 따옴표로 감싼다.

> **이 파일은 하네스 중립 「진실의 원천」이다.** 각 하네스는 어댑터를 통해 이 절차를 실행하며, 어댑터가 「폴링 실행 규칙」의 모드와 **커밋 Co-Author 트레일러**(Step 1)를 지정한다:
> - Claude Code → `.claude/common/pipeline.md` (이 파일로 리다이렉트하는 어댑터)
>
> **하네스별 Co-Author 트레일러** (Step 1 커밋 메시지 끝에 붙는 한 줄):
> - Claude Code → `Co-Authored-By: Claude Code <noreply@anthropic.com>`

**실행 주체**: 전 과정(Step 1~4)을 하나의 실행 흐름이 직접 수행한다.
- **Claude Code**: 메인 세션이 직접 수행하고 서브에이전트에 위임하지 않는다 — 파이프라인은 "액션 → CI/체크 폴링 → 다음 액션"의 반복인데, 서브에이전트 안에서 백그라운드 폴링을 돌리면 완료 후 재개가 안 돼 대기 지점에서 멈춘다. 메인 세션의 `run_in_background` Bash는 완료 시 세션을 확실히 재호출한다.

## 폴링 실행 규칙

CI/CD·PR 체크 대기는 `automation/bin/`의 **폴링 스크립트**(`pr-gate.sh`, `run-wait.sh`)로 실행한다 — 루프를 즉석에서 작성하지 않는다. 스크립트의 *실행 모드*(포그라운드/백그라운드)는 진입 어댑터가 지정한 **하네스별 폴링 모드**를 따른다:

| 하네스 | 폴링 모드 |
|--------|-----------|
| **Claude Code** | 스크립트를 **`run_in_background: true` Bash**로 실행. 포그라운드 `sleep` 차단·Monitor 도구 금지(단일 완료 대기에 부적합). 스크립트 완료 시 세션이 자동 재호출된다. |

- 스크립트는 성공·실패·타임아웃 **모든 종료 상태에서 exit**하고, 종료 직전 결과 마커 1줄(`... result=...`)을 출력한다. 출력의 마커·종료코드로 분기한다. 게이트 정의·간격·타임아웃·마커 규약은 **각 스크립트 상단 주석이 원천**이다.
- GitHub 조회 실패는 pending으로 삼키지 않는다 — 3회 연속 실패 시 `result=API_ERROR` 마커로 종료된다(스크립트에 구현됨). `API_ERROR`는 CI/CD 실패나 `TIMEOUT`과 구분해 실제 stderr를 요약하고 중단한다. GitHub 장애로 단정하지 말고, 하네스의 네트워크 권한·DNS·인증 상태를 함께 확인한다.
- `result=ERROR`는 jq 부재·판정 출력 이상 등 **실행 환경 문제**다(fail-closed) — 통과로 취급하지 않고 환경을 확인해 보고 후 중단한다.
- **알림이 애매하거나 오래 소식이 없으면 추측·무한 대기 말고 즉시 `gh pr view/checks`·`gh run list`로 실제 상태를 확인**한 뒤 분기한다.

## 머지 방식 — dev는 squash, main은 merge commit

이 파이프라인에는 머지가 두 번 나오고 **방식이 서로 다르다. 바꿔 쓰지 않는다.**

| 대상 | 명령 | 결과 커밋 제목 = 해당 CI/CD 런 제목 |
|------|------|--------------------------------------|
| dev PR (Step 1-5) | `gh pr merge <N> --squash` | `[TYPE/#이슈번호] 설명 (#N)` |
| 배포 PR (Step 3-1) | `gh pr merge <N> --merge` | `Merge pull request #N from Cure-Agent/dev` |

**dev PR에 `--merge`를 쓰면 안 되는 이유**: GitHub Actions는 `push` 이벤트 런의 제목으로 **head 커밋 메시지 첫 줄**을 쓴다(`pull_request` 이벤트만 PR 제목을 쓴다). dev PR을 squash하면 그 커밋 제목이 곧 PR 제목이라 `CI - GHCR Build & Push` 런 제목이 앞선 `CI` 런 제목과 일치한다. merge commit으로 머지하면 런 제목이 `Merge pull request #N from Cure-Agent/<이슈브랜치>`가 되어 **어느 변경의 CI인지 런 목록에서 식별할 수 없고**, dev 히스토리에도 브랜치 커밋이 그대로 섞여 「한 줄 = 한 변경」이 깨진다. `run-name`으로는 이 접두사를 걷어낼 수 없어 워크플로우 파일 쪽에 우회책이 없다 — 머지 시점에만 바로잡을 수 있다.

배포 PR(dev→main)은 반대로 `--merge`가 맞다 — 여러 dev 커밋을 하나의 배포 경계로 묶는 것이 목적이고, `CD - GCP Deploy (Main)` 런 제목이 `Merge pull request #N from Cure-Agent/dev`가 되는 것이 의도된 동작이다.

저장소는 dev·main 모두 squash/merge/rebase 세 방식을 허용하고 ruleset도 없다 — 이 규범을 지키는 장치는 이 문서뿐이므로 명령을 그대로 따른다.

## Step 1: 커밋 & PR & 머지 (dev)

1. `git status --short`를 확인해 커밋 안 된 변경이 있으면 `git add -A` → **민감 파일 게이트 통과 후** 커밋한다 (`.cure-implement/` 등 하네스 스크래치는 `.gitignore`가 이미 제외한다). **커밋 제목은 `[TYPE/#이슈번호] 설명` 형식으로 쓴다** — Step 1-4의 PR 제목과 동일 규범이며 `chore:`·`feat:` 등 conventional-commits 형식을 섞지 않는다. squash 머지가 단일 커밋이면 GitHub이 PR 제목 대신 그 커밋 제목을 squash 제목으로 쓰는 폴백이 있으므로, 커밋 제목도 규범에 맞아야 PR-제목 경로든 단일-커밋 폴백이든 dev 히스토리가 일관되게 유지된다. squash 시 GitHub이 자동으로 붙이는 `(#PR번호)` 접미사는 커밋↔PR 자동 링크이므로 그대로 수용하고 수동 제거하지 않는다. 메시지 끝에는 **현재 하네스의 Co-Author 트레일러**를 붙인다 — 진입 어댑터가 지정한 `Co-Authored-By: <이름> <이메일>` 한 줄. 스테이징 후에도 변경이 없으면 커밋을 스킵한다. 게이트는 반드시 스테이징 **후**에 돌린다 — add 이전 검사로는 untracked였던 민감 파일이 잡히지 않는다:
   - 게이트: `automation/bin/sensitive-gate.sh` 실행. `SENSITIVE_GATE result=PASS` → 커밋 진행. `result=BLOCKED`(종료코드 1) → 출력된 파일을 `git reset HEAD <파일>`로 해제하고 보고 후 중단. `result=ERROR` → git 조회 실패(fail-closed) — 통과로 취급하지 않고 보고 후 중단. (Claude Code는 PreToolUse 훅이 추가로 이중 방어한다.)
2. `git pull origin dev --rebase` — 충돌 시 `git rebase --abort` 후 보고하고 중단. (ship Preflight에서 이미 rebase했으므로 보통 no-op이다 — 검증이 도는 동안 dev가 움직인 경우의 안전망.)
3. `git push --force-with-lease -u origin "<브랜치명>"`
4. dev PR 확보 — **기존 PR 확인부터** (재시작 시 같은 브랜치에 열린 PR이 이미 있다):
   - `gh pr list --head "<브랜치명>" --base dev --state open --json number --jq '.[0].number // empty'` — 번호가 나오면 **생성을 스킵**하고 그 번호를 `<dev PR 번호>`로 재사용한다 (3의 push만으로 같은 PR이 업데이트되고 체크가 재실행된다).
   - 없으면 `.github/PULL_REQUEST_TEMPLATE.md` placeholder를 채워 `gh pr create --base dev --head "<브랜치명>" --title "[TYPE/#이슈번호] 설명"`. 출력 URL 끝 숫자가 `<dev PR 번호>`.
5. 머지 게이트 폴링: **`automation/bin/pr-gate.sh <dev PR 번호> 600 build-test`** (30초 간격, 최대 10분) → `PR_GATE_DONE` 마커. **게이트 = `mergeable` MERGEABLE + 앵커 체크(`build-test`) 존재 + 예외 목록을 제외한 모든 체크가 완료·성공 (실패 0, 대기 0, 체크 1개 이상)** — 정확한 판정 로직·비차단 예외 목록은 `automation/bin/pr-gate.jq`가 원천이다(스모크 테스트가 fixture로 검증). 체크를 이름 허용목록으로 고르지 않으므로 dev PR의 다른 체크(docker-build, gitleaks, openapi-breaking 등)도 자동으로 게이트에 포함되고, 잡이 추가·개명돼도 따라간다.
   - `result=PASS` → `gh pr merge <dev PR 번호> --squash` (--auto 금지). **dev PR은 반드시 `--squash`다** — Step 3-1의 배포 PR(`--merge`)과 혼동하지 않는다. 이유는 「머지 방식」 참조.
   - `result=FAIL*` → 마커의 `failed=` 목록에 있는 체크의 로그를 요약해 보고하고 중단. `CONFLICTING`·`TIMEOUT`·`API_ERROR`·`ERROR`도 각각 요약해 중단 (「폴링 실행 규칙」의 구분 참조)
6. `git checkout dev && git pull origin dev`
7. `MERGE_SHA=$(gh pr view <dev PR 번호> --json mergeCommit --jq '.mergeCommit.oid')`

## Step 2: CI & 배포 PR & 체크 대기

1. dev push → CI(`CI - GHCR Build & Push`, `ci-ghcr.yml`) 자동 트리거.
2. CI 폴링: **`automation/bin/run-wait.sh ci-ghcr.yml dev "<MERGE_SHA>" 900`** (60초 간격, 최대 15분) → `RUN_RESULT` 마커.
   - `result=success` → 3으로 진행.
   - `result=failure` 등 실패 conclusion → 마커의 `run_id=`로 `gh run view <run-id> --log-failed`를 요약하고 중단.
   - `result=NOT_FOUND` → run이 아예 생성되지 않았다 — 워크플로우 미트리거(트리거 조건·파일명 변경 등) 신호이므로 `TIMEOUT`(진행 중일 수 있음)과 구분해 보고하고 중단. `TIMEOUT`·`API_ERROR`·`ERROR`는 「폴링 실행 규칙」대로 처리.
3. CI 성공 → 배포 이슈: 이미 있으면 재사용, 없으면 생성한다 — `.github/ISSUE_TEMPLATE/기타-수정.yml`은 GitHub 이슈 폼(form)이므로 그 `body:` 각 항목의 `label`을 마크다운 섹션으로 매핑해 `--body`를 구성하고 `gh issue create --title "[CHORE] 배포" --label "🔩 CHORE"`로 생성. 출력 URL 끝 숫자가 `<배포 이슈 번호>`.
4. 배포 PR 확보 — **기존 PR 확인부터**: `gh pr list --head dev --base main --state open --json number --jq '.[0].number // empty'` — 번호가 나오면 재사용. 없으면 `.github/PULL_REQUEST_TEMPLATE.md`를 채워 `gh pr create --base main --head dev --title "[CHORE/#배포이슈번호] 배포"` (본문에 `close #<배포이슈번호>`). 출력 URL 끝 숫자가 `<배포 PR 번호>`.
5. 배포 PR 게이트 폴링: **`automation/bin/pr-gate.sh <배포 PR 번호> 900 build-and-push`** (30초 간격, 최대 15분) → `PR_GATE_DONE` 마커. 앵커는 `build-and-push`(존재 필수 — dev push CI가 같은 커밋에 남긴 체크), 다른 체크도 전수 검사로 자동 포함된다.
   - `result=PASS` → Step 3 진행.
   - `result=FAIL* mergeable=CONFLICTING` → **단방향 플로우 전제 위반 신호**(Step 3-1과 동일) — 즉시 중단하고 main 히스토리 확인을 요청한다.
   - 그 외 `FAIL*`·`TIMEOUT`·`API_ERROR`·`ERROR` → 실패한 체크 또는 stderr와 배포 PR·이슈 번호를 보고하고 중단.

## Step 3: main 머지

1. `gh pr merge <배포PR번호> --merge` — **`--merge`는 여기(dev→main)에만 쓴다**. Step 1-5의 dev PR은 `--squash`다. 「머지 방식」 참조.
   - 충돌(`CONFLICTING`) 발생 시 — **단방향 플로우 전제 위반 신호** (main에 dev에 없는 커밋 존재). "main에 직접 커밋이 추가된 것으로 보입니다. main 히스토리를 확인해주세요."를 보고하고 **즉시 중단**한다 (AI 자동 해결 금지).

## Step 4: CD & 정리

1. main push → CD(`CD - GCP Deploy (Main)`, `cd-gcp.yml`) 자동 트리거.
2. `CD_SHA=$(gh pr view <배포PR번호> --json mergeCommit --jq '.mergeCommit.oid')`
3. CD 폴링: **`automation/bin/run-wait.sh cd-gcp.yml main "<CD_SHA>" 1200`** (60초 간격, 최대 20분) → `RUN_RESULT` 마커. `result=success`가 아니면(`failure` 등 conclusion·`NOT_FOUND`·`TIMEOUT`·`API_ERROR`·`ERROR`) 아래 4의 실패 분기로 처리.
4. CD 결과:
   - 성공 → 아래 cleanup을 순서대로 시도하되 **각 명령이 실패해도 중단하지 않고 계속 진행**(실패 내역만 기록):
     1. `gh issue close <배포이슈번호>` (default branch가 dev라 자동 완료 안 됨)
     2. `git branch -D "<브랜치명>"`
     3. `git push origin --delete "<브랜치명>"` (이미 삭제됐으면 무시)
     4. 워크트리 정리: `.claude/worktrees/` 내 디렉토리를 `git worktree remove <path> --force` 후 `git worktree prune`. 빈 디렉토리가 남으면 `rm -rf .claude/worktrees/agent-*`, `.claude/worktrees/`가 비면 `rmdir`.
   - 실패 → CD가 실제로 완료돼 실패한 경우에만 마커의 `run_id=`로 `gh run view <run-id> --log-failed`를 요약하고, `API_ERROR`면 스크립트 stderr를, `NOT_FOUND`면 워크플로우 미트리거 가능성을 요약한다. 배포 이슈 번호와 함께 보고하고 중단.
5. 최종 보고: 배포 성공 여부 + cleanup 실패 내역(있으면). 배포 성공 + cleanup 실패는 파이프라인 실패로 취급하지 않는다.

## 실패 시 재시작 규칙

재시작 지점은 아래 매핑을 따른다. **코드 수정·dev push가 수반되면 반드시 Step 2(CI + PR 체크)를 다시 거친다 — CI 검증 없는 배포 금지.**

| 실패 시점 | 원인 | 재시작 | 비고 |
|-----------|------|--------|------|
| Step 1-5 | dev PR 체크 실패 | 코드 수정 → **Step 1** | 같은 브랜치에 push — 기존 dev PR 재사용, 체크 재실행 |
| Step 1-5 | dev PR 충돌 | 충돌 해결 → **Step 1-5** | dev PR 재머지 |
| Step 2-2 | CI(GHCR 빌드) 실패 | 코드 수정 → **Step 1** | 새 커밋, 새 dev PR |
| Step 2-5 | 배포 PR 체크 실패 | 코드 수정 → **Step 1** | 새 커밋, 새 dev PR |
| Step 3-1 | 배포 PR 충돌 | **즉시 중단 → 사용자 보고** | 단방향 전제 위반, AI 자율 해결 금지 |
| Step 4 | CD 실패 | 코드 수정 → **Step 1** | 배포 이슈/PR 재사용 |

- 재시작에 새 브랜치가 필요하면 `fix/#원본번호` 사용 (기존 로컬 브랜치는 삭제 후 생성).
- default branch가 dev이므로 main 머지 PR의 `close #N`은 이슈를 자동으로 닫지 않는다 — 배포 이슈는 명시적으로 닫는다.

## 파괴적 DB 마이그레이션 2단계 배포 원칙

파괴적 마이그레이션은 앱 이미지 롤백 시 이미 적용된 스키마가 되돌아가지 않아, 롤백된 구버전 앱이 사라진 컬럼·테이블을 참조하며 런타임 오류를 낸다 (deploy.sh의 자동 롤백도 스키마는 못 되돌린다).

- **2단계 필수**: `DROP TABLE/COLUMN`, 타입 축소, `RENAME COLUMN`, `ADD NOT NULL`(기존 데이터 있는 컬럼)
- **1단계로 충분**: `CREATE TABLE`, `ADD COLUMN`(nullable/default), 타입 확장, 인덱스 추가

파괴적 변경은 2단계로 분리 배포한다:
- **1차**: 앱 코드에서 기존 스키마 참조 제거 + additive 마이그레이션(있으면)
- **2차**: 파괴적 마이그레이션 (`drizzle/migrations/00xx_drop_*.sql` — 1차 안정 확인 후 별도 배포)

호출자(`/ship`)는 검증 단계에서 파괴적 마이그레이션을 감지해 1차 범위만 파이프라인에 넘기고, 완료 후 2차 작업을 사용자에게 안내한다.

## 환경변수 추가 체크리스트

**새 환경변수** 도입 시 배포 전 아래를 모두 확인한다 (누락 시 프로덕션 앱 시작 실패 또는 기능 무동작). 전달 경로: `GitHub Secrets → CD workflow env → SSH envs → Compose environment → 컨테이너 → 앱 process.env`.

로컬:
1. `.env.example` — 키·주석 추가 (실값 금지)
2. `.env` — 로컬 값 추가

프로덕션:
3. `.github/workflows/cd-gcp.yml` — `jobs.deploy-main.env`에 `NEW_VAR: ${{ secrets.NEW_VAR }}` + `steps[SSH].with.envs` 목록에 `NEW_VAR`
4. `docker/gcp/compose.yml` — app `environment`에 `NEW_VAR: ${NEW_VAR}`
5. `gh secret set NEW_VAR`로 시크릿 등록 — `gh secret list`로 등록 여부를 확인하고 미등록 시 사용자에게 요청한다

## 민감 파일 커밋 금지

`git add/commit/push` 대상에 아래 민감 파일이 포함되지 않도록 커밋 전 확인한다 (기본 이름 및 `<이름>.*` 확장 변형 포함). 기계적 검사는 Step 1의 **`automation/bin/sensitive-gate.sh`**(스테이징 후 `git diff --cached` 검사)가 수행한다 — **스크립트의 정규식이 패턴의 단일 원천**이고, 아래 목록과 훅의 배열은 사람용 요약/이중 방어다(불일치하면 스크립트가 우선). 패턴 변경은 스크립트에서 하고 훅을 같이 갱신한다:

- `.env` (및 `.env.prod` 등 `.env.*` — `.env.example` 제외)
- `.claude/settings.local.json`
- `application-secret.yml`
- `firebase-adminsdk*.json`
- `*.tfvars`, `*.tfstate` (및 `.tfstate.backup`)
- `*.pem`, `*.p12`, `*.p8`, `*.key`
- `id_rsa*`
- GCP 서비스 계정 키 JSON (`terraform/**/*.json`은 `.gitignore`가 차단)

발견 시 커밋하지 말고 사용자에게 보고한다 — 스테이징돼 있으면 `git reset HEAD <file>`로 해제하고, 이미 커밋에 포함됐으면 해당 커밋을 정리한 뒤 재시도한다.

> **하네스별 적용**: 모든 하네스가 Step 1에서 `sensitive-gate.sh`를 실행한다. Claude Code는 PreToolUse 훅(`.claude/hooks/validate-git-sensitive.sh`)이 `git add/commit/push`를 추가로 자동 차단한다(이중 방어). 어느 하네스든 `.gitignore` + GitHub push protection + CI 단 gitleaks와 병행되는 것을 전제로 한다.

## 규칙

- 모든 `gh`/`git` 실패 시 에러 내용을 사용자에게 보고한다.
- 이슈/PR 생성 시 GitHub 템플릿 형식을 준수한다.
- **실패 시 재시작 규칙을 반드시 따른다.**
- **「민감 파일 커밋 금지」 규칙을 준수한다.**
- **머지 방식을 임의로 바꾸지 않는다** — dev PR은 `--squash`, 배포 PR은 `--merge`. 「머지 방식」 참조.
- **`dev`에서 main을 dev로 merge/pull 하는 행위 절대 금지** (`git pull origin main`, `git merge main` 등). dev → main 단방향이라 main에 dev에 없는 커밋이 없다. 역으로 배포 PR(dev→main)에서 `CONFLICTING`이 나면 전제 위반이므로 즉시 중단하고 사용자에게 main 히스토리 확인을 요청한다.
