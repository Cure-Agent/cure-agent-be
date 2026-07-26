# ship — 코드 변경 배포 자동화 (하네스 중립 명세)

워킹 트리의 코드 변경사항을 검증하고 배포까지 자동화한다.
코드 수정이 이미 완료된 상태에서 사용한다. 문제 분석·코드 변경을 수행하지 않는다.
브랜치명에 `#`이 포함되므로, 모든 git/gh 명령에서 브랜치명은 반드시 따옴표로 감싼다.

> **이 파일은 하네스 중립 「진실의 원천」이다.** 직접 실행 대상이 아니라, 사용하는 LLM 하네스의 진입 어댑터를 통해 실행된다:
> - Claude Code → `.claude/commands/ship.md`
> - (다른 하네스 어댑터는 필요 시 추가)
>
> 각 어댑터는 **폴링 모드**와 **안전 규칙 적용 방식**(훅 유무)을 지정한다. 배포(Phase 4)의 CI/CD·PR 체크 폴링은 `automation/pipeline.md`의 「폴링 실행 규칙」에 정의된 **하네스별 모드**를 따른다.

## Preflight

1. `gh auth status` — 인증 실패 시 **중단**
2. `git fetch origin dev` — 이후 모든 dev 대비 비교(변경 유무 판정, 변경 분석)는 **`origin/dev` 기준**이다. 로컬 `dev`는 뒤처져 있을 수 있으므로 비교 기준으로 쓰지 않는다.
3. 현재 상태 확인:
   - **이슈 브랜치에 있는 경우** (브랜치명이 `<prefix>#<번호>` 형식):
     - 브랜치명에서 타입과 이슈번호를 파싱
     - `git log origin/dev..HEAD`와 `git status --porcelain`으로 변경사항 확인 — 커밋도 변경도 없으면 **중단** ("배포할 변경사항이 없습니다"). 변경 유무 판정에 `git diff`(무인자)를 쓰지 않는다 — staged 변경이 보이지 않는다.
     - 최신 동기화: `git pull --rebase --autostash origin dev` — **충돌 시 자동 해결하지 않는다**: rebase 충돌은 `git rebase --abort`로 원상복구 후 보고하고 중단, autostash 재적용 충돌은 변경이 stash에 보존된 상태이므로(`git stash list`로 확인) 그대로 두고 보고하고 중단한다. 이 rebase로 Phase 2가 실제 push될 트리를 검증하고, `automation/pipeline.md` Step 1-2의 rebase는 사실상 no-op이 된다.
     - Phase 1, Phase 3을 스킵하고 Phase 2로 직행
   - **dev 브랜치에 있는 경우**:
     - `git log origin/dev..HEAD --oneline` — **push 안 된 로컬 커밋이 있으면 중단**하고 커밋 목록과 함께 보고한다. dev 직접 커밋은 ship가 배포하지 않는다 — 워킹트리만 보는 아래 판정이 이 커밋들을 놓치므로, 사용자가 브랜치로 옮기는 등 직접 처리해야 한다.
     - `git status --porcelain` — 변경사항이 없으면 **중단** ("배포할 변경사항이 없습니다")
     - 최신 동기화: `git pull --rebase --autostash origin dev` — 충돌 처리는 위 이슈 브랜치 경우와 동일하다(**자동 해결 금지** — 원상복구·보고·중단).
     - Phase 1로 진행

## Phase 1: 변경사항 분석

> 사용자가 인자로 타입과 설명을 직접 제공한 경우 (예: `/ship feat 알림 설정 API 추가`), 해당 값을 사용하고 사용자 확인 없이 Phase 2로 직행한다.

1. `git diff origin/dev`와 `git status --porcelain`(untracked 신규 파일 확인)으로 변경된 파일과 내용을 분석한다. 무인자 `git diff`를 쓰지 않는다 — staged·커밋된 변경이 보이지 않는다. Preflight의 rebase가 선행되므로 이 diff에는 dev 쪽 무관한 변경이 섞이지 않는다.
2. 변경 성격에 맞는 타입을 결정한다:

| 타입 | label | 브랜치 prefix | 이슈 템플릿 |
|------|-------|---------------|-------------|
| `[FEAT]` | `✨ FEAT` | `feat/` | `기능-구현.yml` |
| `[FIX]` | `🔧 FIX` | `fix/` | `기능-수정.yml` |
| `[BUG]` | `🕷️ BUG` | `bug/` | `오류-수정.yml` |
| `[CHORE]` | `🔩 CHORE` | `chore/` | `기타-수정.yml` |
| `[REFACT]` | `♻️ REFACT` | `refact/` | `리팩토링.yml` |
| `[DOCS]` | `📜 DOC` | `docs/` | `문서-작업.yml` |

3. 변경 내용을 한 줄로 요약한다.
4. **사용자 확인 대기**:
   ```
   변경사항 요약:
   - 타입: [FEAT]
   - 설명: ...
   - 변경 파일: N개

   이대로 배포를 진행할까요? (타입이나 설명을 변경하려면 알려주세요)
   ```

## Phase 2: 검증

1. **린트 검증**: `pnpm lint`
2. **빌드 검증**: `pnpm build`
3. **테스트 검증**: 변경된 파일에 따라 관련 테스트를 실행한다:
   - 특정 모듈 변경 시 → 해당 모듈의 spec 실행: `pnpm test -- <변경 모듈 경로 패턴>`
   - API 계약(컨트롤러/DTO/OpenAPI) 변경 시 → `pnpm test:e2e`도 실행 (contract 스펙이 OpenAPI diff=0을 검증한다)
   - 변경 영향 범위가 넓으면 `pnpm test && pnpm test:e2e` 전체 실행
4. **환경변수 체크**: 새 환경변수가 도입된 경우, `automation/pipeline.md`의 「환경변수 추가 체크리스트」를 확인한다.
5. **파괴적 마이그레이션 체크**: `drizzle/migrations/*.sql` 파일이 포함된 경우, `automation/pipeline.md`의 「파괴적 DB 마이그레이션 2단계 배포 원칙」에 따라 파괴적 변경 여부를 판단한다. 파괴적 마이그레이션이 포함되어 있으면 사용자에게 2단계 분리 배포가 필요하다고 보고하고 **중단**한다.
6. 린트·빌드·테스트 실패 시 → 사용자에게 실패 내용을 보고하고 **중단**

## Phase 3: 이슈 & 브랜치

> Preflight에서 이슈 브랜치로 진입한 경우 이 Phase를 스킵한다.

1. 이슈 생성: `gh issue create` — 제목: `[TYPE] 설명`. 본문: 해당 타입의 이슈 템플릿 `.github/ISSUE_TEMPLATE/<타입>.yml`은 GitHub 이슈 폼(form)이므로, 그 `body:` 각 항목의 `label`을 마크다운 섹션 헤더(`## <label>`)로 매핑하고 `required: true` 항목을 빠짐없이 변경 내용으로 채워 `--body`로 전달한다 (폼 파일 자체를 본문으로 붙여넣지 않는다)
2. 브랜치 생성: `"<prefix>#<이슈번호>"` → checkout (변경사항은 워킹 트리에 그대로 유지됨)

## Phase 4: 배포

`automation/pipeline.md`를 읽고 Step 1부터 실행한다.
CI/CD·PR 체크 대기 폴링은 `automation/pipeline.md`의 「폴링 실행 규칙」에 정의된 **현재 하네스의 폴링 모드**를 따른다 (진입 어댑터가 지정).

전달할 컨텍스트:
- 브랜치명, 타입, 이슈번호
- 변경사항 요약 (Phase 1에서 생성한 요약 또는 사용자 인자)

## 규칙

- Phase 1~3에서는 코드를 수정하지 않는다 — 이미 완료된 변경사항을 검증하는 것이 목적이다
- 린트·빌드·테스트 실패 시 (Phase 2) 자동 수정하지 않고 사용자에게 보고한다
- Phase 4 (배포)의 파이프라인 실패 처리는 `automation/pipeline.md`의 규칙을 따른다
- 모든 `gh`/`git` 명령 실패 시 에러 내용 사용자에게 보고
- 이슈/PR 생성 시 GitHub 템플릿 형식 준수
- **민감 파일 커밋 금지**: 배포 과정의 `git add/commit/push`는 `automation/pipeline.md`의 「민감 파일 커밋 금지」 규칙을 따른다 (Claude Code는 훅이 자동 차단하는 이중 방어)
