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

1. **스텁 준비(Claude)**: 컴파일에 필요한 최소 시그니처(서비스 메서드·DTO 뼈대·모듈 배선)와 fixture 컨벤션만 만든다. 로직 금지.
2. **테스트 명세 프롬프트(Claude)**: 대상 레포 루트 `.cure-implement/<번호>-test-prompt.md`(git-ignored)에 작성 — 스펙 전문, 수용 기준별 검증 포인트, 참조 패턴 파일 경로(BE: `test/auth.e2e-spec.ts`, FE: `src/shared/api/http.test.ts`), 스텁 시그니처, 출력 파일 경로, **"테스트·fixture 외 파일 수정 금지"** 명시.
3. **Codex 호출(Claude)** — hang 4중 방어 필수:
   ```bash
   timeout 900 codex exec --sandbox workspace-write -C <대상 레포> \
     < .cure-implement/<번호>-test-prompt.md \
     > .cure-implement/<번호>-codex.log 2>&1
   ```
   - 프롬프트는 반드시 **stdin 리다이렉트(`< file`)** — positional 인자로 주면 stdin 대기 hang
   - 출력은 **파일 리다이렉트** — 파이프 상속 hang 방지
   - **timeout 필수**, 프롬프트에 장기 실행 프로세스(dev 서버·watch) 금지 명시
   - 실패·hang 시 1회 재시도 → 그래도 실패면 **Claude 단독 폴백**(절차 동일, 동결 커밋에 명시)
4. **리뷰(Claude)** — 구현자 관점 개입 금지, 다음만 검사:
   - ① 수용 기준 전 항목이 커버되는가
   - ② **공허 통과** 가능성(미구현 라우트의 404 등으로 이미 통과하는 테스트)이 있는가
   - ③ 스펙에 없는 가정을 추가했는가
   - ④ `git status`로 테스트·fixture 외 파일 무변경 확인
   - 문제 발견 시 프롬프트를 보강해 **Codex에 재작성 요청** — Claude가 assertion을 직접 고치지 않는다. 컴파일 오류 등 기계적 수정만 허용하며 커밋 메시지에 기록한다.
5. 실행해 실패 상태(전부/대부분 실패 = 정상) 확인 후 동결 커밋: `[TEST/#<번호>] <스텝명> 수용 기준 테스트 동결 (작성: Codex)`
6. **이후 구현 중 동결 테스트 수정 금지.** 수정하고 싶어지면 그것은 스펙 결함 신호다 → Phase 1 규칙으로 회귀한다.

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
2. 수용 기준 항목별 → 커버하는 테스트 매핑을 만든다 (최종 보고에 포함).
3. 스펙의 Out of scope를 침범하지 않았는지 점검한다.

## Phase 5 — PR·머지·후속

1. 구현 커밋: `[FEAT/#<번호>] <요약>` — 동결 커밋과 분리 유지. 트레일러:
   `Co-Authored-By: Claude Code <noreply@anthropic.com>`
2. `gh pr create` — 본문에 스펙 링크 + 수용 기준 체크리스트. PR에서만 `openapi-breaking` job이 동작한다.
3. CI green 확인 후 머지한다.
4. **BE 계약이 바뀐 경우**: 머지 후 FE `contract-sync`가 자동 PR(`chore/contract-sync`)을 만들었는지, 그 PR의 typecheck 결과(breaking 여부)까지 확인한다.
5. 최종 보고: 수용 기준 매핑, 계약 변경 여부, FE 동기화 PR 상태.
