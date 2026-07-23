# 07. FE 공통 기반 — http 전송 계층 · app-shell · 로그인

> 구현 레포: **cure-agent-fe** (스펙 홈은 BE — architecture.md §15). 동결 테스트는 FE 레포 vitest.

## 목표

이후 모든 화면(8~11단계)이 딛고 설 FE 기반을 만든다: 3계층 API 원칙(FE 분리본 §2)을 구현한 전송·봉투·스트림 계층, Next.js App Router 골격 + app-shell, 로그인/회원가입 플로우.

## 범위

- **Next.js 스캐폴딩**: App Router + TS + Tailwind. 로컬은 Next rewrites로 BE 프록시(`/api/v1/* → BE_ORIGIN`) — 쿠키 first-party 유지, CORS 불요
- **shared/api** (FE 분리본 §2 계약):
  - `http.ts`: 전송 계층 — `authFetch`(credentials include, 비-GET에 `X-CSRF-Protection` 자동 부착, **401 → single-flight refresh → 원 요청 1회 재시도**), `setUnauthorizedHandler` 주입, refresh 자체는 재시도 루프 제외
  - `api-client.ts`: 생성 클라이언트에 `authFetch` 연결 (generated/client.ts 템플릿에 options 파라미터 추가)
  - `api-error.ts`: 봉투 해석 — `unwrap()`이 success면 data, 실패면 `ApiError(code, message, status, traceId)`
  - `stream-client.ts`: POST SSE — ReadableStream 프레임 조립(청크 경계 안전), `: ping` 무시, 시작 전 401 봉투 → refresh 후 1회 재시도, AbortSignal 지원
  - `query-client.ts`: TanStack Query 기본
- **features/auth**: useMe/useLogin/useSignup/useLogout + 로그인·회원가입 폼
- **widgets/app-shell**: 사이드바 내비(어시스턴트/지침/환자/히스토리) + 사용자 정보·로그아웃
- **app/**: `(auth)/login·signup`, `(protected)/layout`(useMe 복구, 미인증 → /login) + 4개 화면 placeholder

## 추가 에러코드

- 없음 (BE 계약 변경 없음)

## 수용 기준 (= 동결할 FE 테스트, vitest)

1. authFetch: 401 응답 → refresh POST → 원 요청 재시도 성공 (fetch 호출 순서 검증)
2. 동시 401 N건 → refresh는 **1회만**(single-flight), 전원 재시도
3. refresh 실패 → `onUnauthorized` 1회 호출, 원 401 그대로 반환
4. 비-GET에 `X-CSRF-Protection: 1` 자동 부착, GET에는 미부착
5. refresh 요청 자체는 401이어도 재귀 재시도하지 않음
6. stream-client: 이벤트 순서 보존 + **청크 경계가 프레임을 갈라도** 조립됨
7. stream-client: `: ping` 주석 프레임 무시
8. stream-client: 시작 전 401 → refresh 후 1회 재시도로 스트림 성공
9. unwrap: 성공 봉투 → data 반환, 실패 봉투 → ApiError(code·traceId 보존)
10. 로그인 폼: 제출 → login mutation 호출, 성공 시 `/assistant` 라우팅 (RTL)

## Out of scope

- 화면 실구현(어시스턴트/지침/환자/히스토리) — 8~11단계
- MSW 기반 feature 테스트 인프라(8단계에서 도입), E2E 브라우저 테스트
- 운영 배포 구성(도메인·CORS/프록시 전략 확정) — 12단계
