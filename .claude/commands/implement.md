---
description: docs/specs/ 스펙 기반 SDD 구현 — 테스트 동결 → 구현 → 검증 → PR
argument-hint: <spec 번호 또는 경로 (예: 05)>
---

# /implement — 스펙 기반 구현 하네스

`docs/architecture.md` §15 "5단계 이후 작업 규칙(SDD)"의 실행 절차다.
**스펙이 계약이고, 동결된 테스트가 심판이다.** 이 절차 밖의 임기응변을 금지한다.

## Phase 0 — Preflight

1. `$ARGUMENTS`로 스펙을 결정한다: 숫자면 `docs/specs/<번호>-*.md` 매칭, 경로면 그대로. 못 찾으면 `ls docs/specs/`를 보여주고 중단한다.
2. 스펙 전문 + 스펙이 §링크한 `docs/architecture.md` 섹션을 읽는다. §3(구조·경량화 원칙), §10(응답·에러 규약), §13(테스트 전략)은 항상 포함.
3. `git status` clean 확인, `git pull` 후 브랜치 생성: `feat/<번호>-<이름>`.

## Phase 1 — 계획

- 수용 기준 각 항목 ↔ 구현 파일·마이그레이션·에러코드 매핑 계획을 세운다.
- **스펙에 모호함·결함이 있으면 구현하지 않는다.** 스펙 수정안을 먼저 제시해 확정한 뒤 진행한다. 테스트 동결 후 발견해도 동일: spec 수정 → 재동결, 사유를 커밋 메시지에 남긴다.

## Phase 2 — 테스트 동결 (작성: Codex / 리뷰·동결: Claude)

**원칙: 심판(테스트)과 선수(구현)를 같은 에이전트가 만들지 않는다.** 같은 에이전트가 둘 다 만들면 스펙 오독이 테스트와 구현 양쪽에 복제되어 서로를 통과시킨다. 수용 기준 테스트는 Codex가 스펙에서 독립 파생 작성하고, Claude는 리뷰·동결만 한다.

1. **스텁 준비(Claude)**: 컴파일에 필요한 최소 시그니처(서비스 메서드·DTO 뼈대·모듈 배선)와 fixture 컨벤션만 만든다. 로직 금지. 스텁은 **동결 커밋과 분리해 먼저 커밋**한다(`[TEST/#<번호>] 스텁 준비`) — 동결 커밋에 테스트·fixture만 남아야 Phase 4 감사가 파일 목록을 동결 커밋 자체에서 복원할 수 있다.
2. **테스트 명세 프롬프트(Claude)**: 대상 레포 루트 `.cure-implement/<번호>-test-prompt.md`(git-ignored)에 작성 — 스펙 전문, 수용 기준별 검증 포인트, 참조 패턴 파일 경로(BE: `test/auth.e2e-spec.ts`, FE: `src/shared/api/http.test.ts`), 스텁 시그니처, 출력 파일 경로, **"테스트·fixture 외 파일 수정 금지"**·**"모든 테스트는 스텁 상태에서 실패해야 한다 (이미 통과하는 테스트는 구현을 검증하지 못하는 공허 테스트)"** 명시.
3. **Codex 호출(Claude)** — hang 4중 방어 + 모델 핀 필수:
   ```bash
   timeout 900 codex exec --sandbox workspace-write -C <대상 레포> \
     -m gpt-5.6-sol \
     -c model_reasoning_effort="xhigh" \
     -c mcp_servers='{}' \
     --color never \
     < .cure-implement/<번호>-test-prompt.md \
     > .cure-implement/<번호>-codex.log 2>&1
   ```
   - 프롬프트는 반드시 **stdin 리다이렉트(`< file`)** — positional 인자로 주면 stdin 대기 hang
   - 출력은 **파일 리다이렉트** — 파이프 상속 hang 방지
   - **timeout 필수**, 프롬프트에 장기 실행 프로세스(dev 서버·watch) 금지 명시. `-c mcp_servers='{}'`로 MCP를 전부 비운다 — 테스트 생성에 불필요하고 hang 표면만 늘린다
   - **모델·reasoning effort는 플래그로 명시 고정** — 팀원별 `~/.codex/config.toml` 편차로 심판(테스트) 품질이 조용히 열화되는 것을 막는다(플래그가 config보다 우선). 핀은 lockfile처럼 의존성 버전으로 관리한다: **핀 모델 미가용**(model not found류 에러) 시 기본 모델(`-m`·effort 플래그 제거)로 1회 재시도하고 동결 커밋에 사용 모델을 명시한다
   - 실패·hang 시 1회 재시도 → 그래도 실패면 **Claude 단독 폴백** — **동결 포함 절차 동일**(동결의 가치 절반인 "구현 루프 중 테스트 변조 방지"는 작성자 분리 없이도 성립한다), 동결 커밋에 `작성: Claude 단독` 명시. 이때 자기 리뷰는 독립성이 없으므로 5번 기계 게이트가 주 방어선이 된다
4. **리뷰(Claude)** — 구현자 관점 개입 금지, 다음만 검사:
   - ① 수용 기준 전 항목이 커버되는가
   - ② **공허 통과** 가능성(미구현 라우트의 404 등으로 이미 통과하는 테스트)이 있는가
   - ③ 스펙에 없는 가정을 추가했는가
   - ④ `git status`로 테스트·fixture 외 파일 무변경 확인
   - 문제 발견 시 프롬프트를 보강해 **Codex에 재작성 요청** — Claude가 assertion을 직접 고치지 않는다. 컴파일 오류 등 기계적 수정만 허용하며 커밋 메시지에 기록한다.
5. **동결 게이트 — 3계층 기계 검증(Claude)**. 4번 리뷰는 정성 검사라 커버리지·가정을 보고, 이 게이트는 기계 검사다 — 둘은 보완재. 세 계층 모두 통과해야 동결한다:
   - ① **Discovery**: `pnpm test -- <신규 spec 경로>`(e2e는 `pnpm test:e2e -- <경로>`) 출력에 신규 테스트 파일이 실제로 잡히는지 확인 — "No tests found"는 러너 패턴 불일치로, 영원히 조용히 통과(스킵)되는 파일이라는 뜻이다
   - ② **빌드 GREEN**: `pnpm build && pnpm lint` 통과 — 동결 커밋은 이후 구현의 base이므로 컴파일되는 커밋이어야 한다
   - ③ **실행 RED (테스트 단위)**: **모든 테스트가 개별적으로** 실패하는지 확인한다. 스위트 단위의 "전부/대부분 실패"로 만족하지 않는다 — 스텁 상태에서 **통과하는 테스트를 기계적으로 열거**하고, 건별로 정당화되지 않으면 Codex에 재작성 요청한다. 스텁(= 아무것도 안 하는 구현)을 죽이지 못하는 테스트는 정의상 공허 테스트다. 특히 e2e에서 **미구현 라우트의 404로 우연히 통과하는 테스트**(리뷰 ②의 함정)가 여기서 기계적으로 걸린다. 부트스트랩 실패·컴파일 에러로 죽으면 RED가 아니라 broken — 수정 후 재검증한다
6. 동결 커밋: `[TEST/#<번호>] <스텝명> 수용 기준 테스트 동결 (작성: Codex)` — 폴백 시 `작성: Claude 단독`, 기계적 수정·모델 폴백이 있었으면 사유 병기. **동결 커밋에는 테스트·fixture만 포함**한다(스텁은 1번에서 별도 커밋 완료).
7. **동결 등록(훅+감사 기준)**:
   - 테스트 파일 경로(레포 루트 기준 상대)를 `.cure-implement/frozen-tests.txt`에 한 줄씩 기록 — 즉시 PreToolUse 훅(`.claude/hooks/freeze-test-files.sh`)이 해당 파일의 Edit/Write를 차단한다(예방)
   - `git rev-parse HEAD > .cure-implement/frozen-commit.txt` — Phase 4 감사 기준 SHA. 재동결 시 갱신한다
   - `.cure-implement/`는 git-ignored라 이 상태 파일들은 변조 가능하다 — 감사의 불변 기준은 목록 파일이 아니라 **동결 커밋 자체**다(Phase 4 참조)
8. **이후 구현 중 동결 테스트 수정 금지.** **기본 추정은 구현 결함이다** — 동결은 "테스트가 맞다"는 추정이므로 입증 책임은 구현 쪽에 있다. 수정하고 싶어지면 그것은 스펙 결함 신호다 → Phase 1 규칙으로 회귀한다(스펙 수정 → Codex 재파생 → 재동결 + `frozen-commit.txt` 갱신, 판단 사유를 커밋 메시지에). 훅은 Edit/Write만 막으므로 Bash 우회 편집(`sed -i` 등)은 Phase 4 감사가 잡는다.

## Phase 3 — 구현

동결 테스트가 전부 통과할 때까지 구현한다. 필수 규칙:

- 에러는 `ServiceException(ErrorCode)`만 사용. code 문자열 리터럴 금지. 새 코드는 레지스트리 + architecture.md §10.2 **같은 커밋**에서 갱신
- patient/conversation 계열 repository 메서드는 `ClinicScope` 필수 인자 (§4.4). 타 스코프 리소스는 404
- 민감 필드는 AES-GCM 암호화 저장, 검색 필요 시 HMAC blind index (§4.5)
- 마이그레이션은 새 파일 추가만 — 적용된 파일 수정 금지 (§12). 전 테이블 `base-columns`
- Entity를 컨트롤러에서 직접 반환 금지 — mapper → Response DTO (§3)
- 포트(인터페이스)는 llm/embedding/retrieval에만. CRUD 도메인은 Drizzle repository 단일 클래스 (§3)
- DTO·컨트롤러 변경 시 `pnpm openapi:export` 실행 후 스펙을 함께 커밋 (contract 테스트가 누락을 잡는다)

## Phase 4 — 검증

1. `pnpm lint && pnpm test && pnpm test:e2e && pnpm build` 전부 green.
2. **동결 무결성 감사**: 훅(예방)은 Edit/Write 도구만 막는다 — Bash 우회 편집은 이 감사로만 탐지된다(훅=예방, diff=감사, 두 층이 필요하다). 감사 파일 목록은 워킹 트리의 `frozen-tests.txt`(변조 가능)가 아니라 **동결 커밋에서 복원**한다 — 목록 파일에서 줄을 지우는 것만으로 감사 범위에서 빠지는 순환을 끊는다: `FC=$(cat .cure-implement/frozen-commit.txt)` → `git diff-tree --no-commit-id --name-only -r "$FC"`로 목록 복원(동결 커밋에는 테스트·fixture만 있다) → `git diff "$FC" -- <복원한 목록>`이 **비어야** 한다. 비어있지 않으면 중단하고 사용자에게 보고한다. 감사는 항상 **마지막 코드 변경 뒤**에 실행하고, 감사 이후 코드가 다시 바뀌면 재실행한다.
3. 수용 기준 항목별 → 커버하는 테스트 매핑을 만든다 (최종 보고에 포함).
4. 스펙의 Out of scope를 침범하지 않았는지 점검한다.

## Phase 5 — PR·머지·후속

1. 구현 커밋: `[FEAT/#<번호>] <요약>` — 동결 커밋과 분리 유지. 트레일러:
   `Co-Authored-By: Claude Code <noreply@anthropic.com>`
2. `gh pr create` — 본문에 스펙 링크 + 수용 기준 체크리스트. PR에서만 `openapi-breaking` job이 동작한다.
3. CI green 확인 후 머지한다. 머지 성공 후 `.cure-implement/frozen-tests.txt`·`frozen-commit.txt`를 삭제한다(동결 해제) — 머지 실패로 재수정하는 동안은 동결을 유지해 테스트를 계속 보호한다.
4. **BE 계약이 바뀐 경우**: 머지 후 FE `contract-sync`가 자동 PR(`chore/contract-sync`)을 만들었는지, 그 PR의 typecheck 결과(breaking 여부)까지 확인한다.
5. 최종 보고: 수용 기준 매핑, 계약 변경 여부, FE 동기화 PR 상태.
