# 17. 소셜 로그인 전환

> 이 스텝은 `architecture.md` §4(인증·보안 설계)를 개정한다 — 개정 이력 #18.

## 목표

이메일·비밀번호 인증을 제거하고 소셜 로그인(Google/Kakao/Naver)만으로 인증한다. 소셜 인증이 끝난 신규 사용자는 티켓을 들고 온보딩 화면으로 이동해 한의원명·면허번호를 입력한 뒤 가입이 완료된다.

## 범위 (엔드포인트)

| API | Request | Response data | 참조 |
|---|---|---|---|
| GET /auth/oauth/providers | — | OAuthProvidersResponseDto | §4.2 |
| GET /auth/oauth/{provider} | — | 302 → 제공자 동의 화면 (+ state 쿠키) | §4.1 |
| GET /auth/oauth/{provider}/callback | code, state, error | 302 → FE (쿠키 또는 ticket) | §4.1 |
| POST /auth/signup | CompleteSignUpRequestDto | AuthSessionResponseDto (201) | §4.2 |

- 제거: `POST /auth/login`, `GET /auth/email-availability`, `PasswordHasher`
- `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`는 그대로다 — 세션 수명주기(§4.3)는 인증 수단과 무관하다.

**콜백 오리진**: 콜백은 BE 오리진이 아니라 **FE 오리진의 `/api/v1/...`** 로 받는다(FE의 Next rewrites 프록시 경유). 제공자가 브라우저를 BE 오리진으로 직접 보내면 발급 쿠키가 BE 도메인에 저장돼 FE 요청에 실리지 않는다. `OAUTH_WEB_BASE_URL`이 이 오리진이며, 제공자 콘솔에 등록할 Redirect URI는 `{OAUTH_WEB_BASE_URL}/api/v1/auth/oauth/{provider}/callback`이다.

**티켓**: 검증된 소셜 신원(provider·providerId·email)을 Redis에 담고 브라우저에는 불투명 티켓만 준다 → FE가 이메일·providerId를 위조할 수 없다. GETDEL로 1회성이며, denylist(§4.3)와 달리 **fail-closed**다.

## Entity / 마이그레이션 변경분

- `clinicians.password_hash` 삭제
- `clinicians.oauth_provider` (enum GOOGLE|KAKAO|NAVER, NOT NULL), `clinicians.oauth_provider_id` (text, NOT NULL)
- `uq_clinicians_oauth` unique index on (oauth_provider, oauth_provider_id) — 계정 동일성의 단일 기준
- `uq_clinicians_email`은 유지 — 한 이메일은 하나의 소셜 계정에만 묶인다
- 마이그레이션 `0006_social_auth`는 기존 `clinicians` 행이 있으면 중단한다(소셜 신원 자동 이관 불가)

## 추가 에러코드

- `AUTH_OAUTH_PROVIDER_UNSUPPORTED` (400), `AUTH_OAUTH_STATE_MISMATCH` (400), `AUTH_OAUTH_DENIED` (400), `AUTH_OAUTH_EMAIL_MISSING` (400), `AUTH_OAUTH_FAILED` (401), `AUTH_OAUTH_TICKET_INVALID` (401)
- 제거: `AUTH_INVALID_CREDENTIALS`
- 콜백 경로의 실패는 JSON 봉투가 아니라 `{FE}/login?error=<code>` 리다이렉트로 전달한다 — 브라우저 내비게이션 중이라 사용자에게 원시 JSON을 보일 수 없다.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

1. `GET /auth/oauth/providers` → client id가 설정된 제공자만 반환한다.
2. `GET /auth/oauth/google` → 302 + `oauth_state` 쿠키(HttpOnly, SameSite=Lax, Path=/api/v1/auth/oauth). Location의 `state`가 쿠키와 같고 `redirect_uri`가 `{OAUTH_WEB_BASE_URL}/api/v1/auth/oauth/google/callback`이다.
3. 미지원 제공자로 시작 → `{FE}/login?error=AUTH_OAUTH_PROVIDER_UNSUPPORTED`.
4. 콜백(신규 사용자) → 계정을 만들지 않고 `{FE}/signup?ticket=...`로 302하며 인증 쿠키를 발급하지 않는다.
5. 콜백(기존 사용자) → `{FE}/assistant`로 302 + access/refresh 쿠키. **이메일이 바뀌어도 providerId가 같으면 같은 계정**이다.
6. state 불일치 → `AUTH_OAUTH_STATE_MISMATCH`, 동의 취소(`error` 파라미터) → `AUTH_OAUTH_DENIED`.
7. 이메일 미동의 신규 사용자 → `AUTH_OAUTH_EMAIL_MISSING` (기존 사용자는 이메일 없이도 로그인된다).
8. `POST /auth/signup`(티켓 + 한의원명·면허번호·이름·약관) → 201 + 쿠키 + PENDING. **이메일은 바디가 아니라 티켓에서 나온다.**
9. 면허번호는 DB에 키버전 포함 암호문으로만 저장된다 (§4.5).
10. 티켓 재사용·위조·만료 → 401 `AUTH_OAUTH_TICKET_INVALID`.
11. 다른 소셜 계정이 선점한 이메일로 가입 → 409 `AUTH_EMAIL_ALREADY_USED`.
12. refresh rotation·재사용 감지·로그아웃 denylist(§4.3)는 소셜 세션에서도 동일하게 동작한다.

FE:

13. `/login`은 활성 제공자 링크만 렌더하고, 각 링크는 `/api/v1/auth/oauth/{provider}`로 가는 **전체 페이지 이동**이다(fetch 금지 — 302를 XHR이 따라가면 플로우가 성립하지 않는다).
14. `/login?error=<code>`는 코드에 대응하는 한국어 문구를 보여준다.
15. `/signup`은 `?ticket=` 없이 진입하면 `/login`으로 보낸다.
16. 온보딩 제출 → `{ticket, displayName, clinicName, licenseNumber, termsAccepted}`만 전송하고 성공 시 `/assistant`로 이동한다.

## Out of scope

- Apple 로그인 (웹 전용 서비스에는 불필요, Service ID·client_secret JWT 설정 부담이 크다)
- 계정 연결(account linking) — 한 사람이 Google과 Kakao를 같은 계정에 묶는 기능. 현재는 이메일 unique로 두 번째 가입을 막기만 한다.
- 네이티브 앱용 SDK 토큰 검증 엔드포인트 (`POST /auth/social-login`)
- 기존 비밀번호 계정의 소셜 계정 이관 절차
