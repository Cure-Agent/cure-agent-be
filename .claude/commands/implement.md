---
description: docs/specs/ 스펙 기반 SDD 구현 — 이슈·브랜치 → 테스트 동결 → 구현 → 검증 → 배포(ship 위임)
argument-hint: <spec 번호 또는 경로 (예: 05)>
---

# /implement — 스펙 기반 구현 하네스

`docs/architecture.md` §15 "5단계 이후 작업 규칙(SDD)"의 실행 절차다.
**스펙이 계약이고, 동결된 테스트가 심판이다.** 이 절차 밖의 임기응변을 금지한다.

## Phase 0 — Preflight

1. `$ARGUMENTS`로 스펙을 결정한다: 숫자면 `docs/specs/<번호>-*.md` 매칭, 경로면 그대로. 못 찾으면 `ls docs/specs/`를 보여주고 중단한다.
2. 스펙 전문 + 스펙이 §링크한 `docs/architecture.md` 섹션을 읽는다. §3(구조·경량화 원칙), §10(응답·에러 규약), §13(테스트 전략)은 항상 포함.
3. `git status` clean 확인, `git checkout dev && git pull origin dev`.
4. **이슈 생성**: `gh issue create --title "[FEAT] <스텝명>" --label "✨ FEAT"` — 본문은
   `.github/ISSUE_TEMPLATE/기능-구현.yml`의 `body:` 각 항목 `label`을 마크다운 헤더(`## <label>`)로
   매핑하고 `required: true` 항목을 스펙의 범위·수용 기준으로 채워 `--body`로 전달한다(폼 파일 자체를
   붙여넣지 않는다). 출력 URL 끝 숫자가 `<이슈번호>`다.
5. 브랜치 생성: `"feat/#<이슈번호>"` → checkout. 브랜치명에 `#`이 포함되므로 모든 git/gh 명령에서
   **반드시 따옴표로 감싼다**.

> **`#N` 자리에는 항상 이슈 번호를 쓴다 — spec 번호가 아니다.** GitHub은 커밋·PR 제목의 `#N`을
> 이슈 참조로 자동 링크하므로, spec 번호를 쓰면 같은 번호의 무관한 이슈에 걸린다
> (실제 사고: `[FEAT/#18]`로 커밋한 spec 18 구현이 이슈 #18 `[CHORE] 배포`에 연결됨).
> spec은 본문·PR에서 `docs/specs/<번호>` 경로로 참조한다. 이 규범은 `automation/pipeline.md`
> Step 1(`[TYPE/#이슈번호] 설명`)과 동일하다.

## Phase 1 — 계획

- 수용 기준 각 항목 ↔ 구현 파일·마이그레이션·에러코드 매핑 계획을 세운다.
- **스펙에 모호함·결함이 있으면 구현하지 않는다.** 스펙 수정안을 먼저 제시해 확정한 뒤 진행한다. 테스트 동결 후 발견해도 동일: spec 수정 → 재동결, 사유를 커밋 메시지에 남긴다.

## Phase 2 — 테스트 동결 (작성: Codex / 리뷰·동결: Claude)

**절차 원본은 `automation/freeze.md`다.** 그 문서를 읽고 아래 파라미터로 실행한다:

| 파라미터 | 값 |
|---|---|
| 명세 | Phase 0에서 읽은 스펙 전문 + §링크한 architecture.md 섹션 |
| 작업 ID | **이슈 번호** (Phase 0-4에서 발급 — 커밋 제목 `[TEST/#<이슈번호>]`에 쓰인다) |
| 동결 단위 | 스펙 1개 = 1 단위 |
| 참조 패턴 파일 | BE `test/auth.e2e-spec.ts` / FE `src/shared/api/http.test.ts` |

동결 중 **스펙 결함**(수용 기준이 모호·모순)을 발견하면 `automation/freeze.md`의 TEST-DISPUTE 분류에 따라 **Phase 1 규칙으로 회귀**한다 — 스펙을 먼저 고치고 Codex 재파생 → 재동결, 사유는 커밋 메시지에 남긴다.

## Phase 3 — 구현

동결 테스트가 전부 통과할 때까지 구현한다. 필수 규칙:

- 에러는 `ServiceException(ErrorCode)`만 사용. code 문자열 리터럴 금지. 새 코드는 레지스트리 + architecture.md §10.2 **같은 커밋**에서 갱신
- patient/conversation 계열 repository 메서드는 `ClinicScope` 필수 인자 (§4.4). 타 스코프 리소스는 404
- 민감 필드는 AES-GCM 암호화 저장, 검색 필요 시 HMAC blind index (§4.5)
- 마이그레이션은 새 파일 추가만 — 적용된 파일 수정 금지 (§12). 전 테이블 `base-columns`
- Entity를 컨트롤러에서 직접 반환 금지 — mapper → Response DTO (§3)
- 포트(인터페이스)는 **프로세스 밖 경계**(외부 HTTP·유료 API)에만 — "감싸지 않으면 수용 기준을 동결할 수 없는가"가 기준이다. CRUD 도메인은 Drizzle repository 단일 클래스 (§3)
- DTO·컨트롤러 변경 시 `pnpm openapi:export` 실행 후 스펙을 함께 커밋 (contract 테스트가 누락을 잡는다)

## Phase 4 — 검증

1. `pnpm lint && pnpm test && pnpm test:e2e && pnpm build` 전부 green.
2. **동결 무결성 감사**: `automation/freeze.md`의 「사후 감사」를 실행한다 — 동결 커밋에서 목록을 복원해 `git diff`가 비어 있는지 확인하고, 비어있지 않으면 중단·보고한다. 감사는 항상 **마지막 코드 변경 뒤**에 실행하고, 감사 이후 코드가 다시 바뀌면 재실행한다.
3. 수용 기준 항목별 → 커버하는 테스트 매핑을 만든다 (최종 보고에 포함).
4. 스펙의 Out of scope를 침범하지 않았는지 점검한다.
5. **사용자 확인 대기** — 수용 기준 매핑·계약 변경 요약을 보고하고 배포 승인을 받는다. 추가 수정 요청 시 반복. OK 시에도 **동결은 아직 해제하지 않는다**(배포 실패로 재수정하는 시나리오에서 테스트가 무방비가 되지 않도록).

   > **spec 승인이 이것을 대체하지 않는다.** spec은 「무엇을 만들지」의 합의이고 여기는 「이렇게
   > 만들어진 결과물을 배포할지」다. Phase 5가 `automation/ship.md`에 위임하면 ship의 Preflight가
   > 이슈 브랜치를 감지해 **Phase 1·3을 스킵**하므로 ship이 가진 사용자 확인이 건너뛰어지고,
   > 이후 `automation/pipeline.md`가 dev PR → 자동 머지 → CI → 배포 PR → 프로덕션 CD까지 멈추지
   > 않는다. 이 항목이 없으면 구현 완료부터 프로덕션까지 개입 지점이 **하나도 없다** —
   > PR은 게이트 통과 즉시 squash 머지되므로 사람이 PR을 볼 시간이 구조적으로 없다.
   > `automation/problem.md` Phase 5-5와 같은 지점·같은 문구다.

## Phase 5 — 배포·후속

1. 구현 커밋: `[FEAT/#<이슈번호>] <요약>` — 동결 커밋과 분리 유지. 트레일러:
   `Co-Authored-By: Claude Code <noreply@anthropic.com>`
2. **배포는 `automation/ship.md`에 위임한다.** 그 문서를 읽고 실행하면 현재 이슈 브랜치를
   Preflight가 감지해 **Phase 1·3을 스킵하고 Phase 2(검증)로 직행**하며, Phase 4에서
   `automation/pipeline.md`가 dev PR → CI → 배포 PR → CD까지 수행한다.
   전달할 컨텍스트: 브랜치명, 타입(`[FEAT]`), 이슈번호, Phase 4의 검증 결과 요약.
   - PR 본문에는 **스펙 링크(`docs/specs/<번호>`) + 수용 기준 ↔ 테스트 매핑 표**를 넣는다.
     dev PR에서만 `openapi-breaking` job이 동작한다.

   > **머지 방식을 임의로 바꾸지 않는다** — dev PR은 `--squash`, 배포 PR(dev→main)은 `--merge`다.
   > 이유는 `automation/pipeline.md`의 「머지 방식」 참조: dev PR을 merge commit으로 머지하면
   > GitHub Actions 런 제목이 `Merge pull request #N from ...`이 되어 **어느 변경의 CI인지
   > 런 목록에서 식별할 수 없다.** 이 스텝에서 직접 `gh pr merge`를 호출하지 않는다.

3. **배포 성공 후** `automation/freeze.md`의 「동결 해제」를 수행한다 — 배포가 실패해 코드를
   재수정하는 동안은 동결을 유지해 테스트를 계속 보호한다.
4. **브랜치 정리**는 `automation/pipeline.md` Step 4가 수행한다(배포 이슈 close, 로컬·원격 브랜치
   삭제, 워크트리 정리). 누락되면 스텝마다 브랜치가 누적되므로 최종 보고 전에 `git branch -a`로
   확인한다.
   > **squash·rebase 머지 함정**: 두 방식 모두 커밋 SHA를 새로 만들므로 원본 브랜치는 대상 브랜치의
   > 조상이 **아니다**. `git branch --merged`에 잡히지 않고 `git branch -d`도 거부한다. 남은 브랜치를
   > 지울 때 `-d` 실패를 이유로 곧장 `-D`를 쓰지 말고, **PR 머지 여부를 먼저 확인**한 뒤 확인된 것만
   > `-D`로 지운다: `gh api "repos/<owner>/<repo>/pulls?state=all&head=<owner>:<브랜치>" --jq '.[0].merged_at'`
   > 확인 없이 `-D`를 쓰면 머지되지 않은 작업을 조용히 날린다.
5. **BE 계약이 바뀐 경우**: 머지 후 FE `contract-sync`가 자동 PR(`chore/contract-sync`)을 만들었는지, 그 PR의 typecheck 결과(breaking 여부)까지 확인한다.
6. 최종 보고: 수용 기준 매핑, 계약 변경 여부, FE 동기화 PR 상태.
