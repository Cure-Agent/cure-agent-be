# Cure Agent 아키텍처 설계 문서

> **이 문서가 설계의 원본(single source of truth)입니다.**
> 계약(DTO, 에러코드, SSE)을 변경하는 PR은 반드시 같은 PR에서 이 문서를 함께 갱신합니다.
> FE 레포의 `docs/architecture.md`는 FE 파트 분리본이며, 공통 계약은 이 문서를 링크로 참조합니다.

---

## 0. 결정 요약

| 항목 | 결정 |
|---|---|
| FE | app + widgets + features + shared (widgets는 최소화) |
| BE | 도메인별 controller → service → repository → entity 모듈러 모놀리스 |
| 계약 | NestJS DTO → OpenAPI → FE 타입·클라이언트 자동 생성 (파이프라인은 초기 구축) |
| Entity | BE에만 존재, OpenAPI 미노출 |
| 응답 | 일반 JSON은 공통 봉투 + 에러코드 레지스트리 단일 소스 |
| SSE | 봉투 미적용, 이벤트 스키마 + 끊김 복구 계약 포함 |
| 인증 | HttpOnly 쿠키 + CSRF 가드 + refresh rotation·재사용 감지 + Redis denylist 즉시 무효화 |
| 테넌시 | 모든 조회는 clinic 스코프 강제 (repository 시그니처 레벨) |
| 민감정보 | AES-GCM 필드 암호화 + HMAC blind index |
| LLM | 포트 + 재시도 + 서킷브레이커 + rate-limit 차단 + 프로바이더 폴백 라우팅 |
| 환자 추천 | Prescription이 아닌 ClinicalGuidance로 모델링, 의료인 검토 상태 기록 |

---

## 1. API 계약 관리 방식

```
NestJS Request/Response DTO + Controller decorator
                     │  scripts/export-openapi.ts (BE CI가 아티팩트로 export)
                     ▼
           openapi/cure-agent.v1.json
                     │  CI: ① 재생성 diff = 0 검증  ② openapi-diff로 breaking change 검사
                     ▼
        FE generated TypeScript types + client
```

역할 구분:

- **BE DTO 클래스**: 계약의 유일한 원본. interface가 아닌 실제 class로 작성하고 ValidationPipe + class-validator 적용.
- **OpenAPI 문서**: 두 레포 사이의 공식 계약.
- **FE generated 타입**: OpenAPI에서 자동 생성된 소비 코드. FE에 수동 DTO(`interfaces/response/*`)를 만들지 않는다.
- **Entity**: DB·도메인 내부 모델. OpenAPI에 노출하지 않는다.

운영 규칙:

- **두 레포 동기화(자동)**: 계약 변경 시 개발자는 `pnpm openapi:export`로 스펙을 갱신·커밋한다(누락 시 contract 테스트가 CI에서 실패). BE main에 `openapi/**` 변경이 push되면 `contract-notify` 워크플로우가 FE에 `repository_dispatch(contract-updated)`를 발사하고, FE의 `contract-sync` 워크플로우가 `api:sync` 후 **동기화 PR(`chore/contract-sync`)을 자동 생성**한다. dispatch 토큰(`CONTRACT_SYNC_TOKEN`)이 없거나 만료되면 `contract-notify` job이 **실패해 즉시 드러난다** — 조용한 폴백(cron)은 두지 않는다. **breaking 변경은 동기화 PR의 typecheck 실패로 표면화**되며, FE 적응 커밋을 같은 PR에 쌓아 머지한다. FE CI는 커밋된 스펙 기준 재생성 diff=0을 검사해 수동 편집을 기계적으로 차단한다.
- **생성 도구**: `openapi-typescript` + `openapi-fetch`. TanStack Query hook은 각 feature에서 정의. SSE는 별도 stream-client.
- **enum 전방 호환**: OpenAPI enum에 값이 추가될 수 있음을 전제로, FE는 unknown variant를 안전하게 무시/기본 렌더링한다(exhaustive switch에 `default` 필수).
- 주요 에러 코드는 `@ApiEnvelopeResponse`의 에러 응답 정의에 함께 문서화해 FE가 분기 케이스를 계약으로 받게 한다.
- DTO의 class-validator + `@ApiProperty` 이중 데코레이션이 부담되면 `@nestjs/swagger` CLI plugin으로 자동화.

---

## 2. cure-agent-fe 구조

```
cure-agent-fe/
├── openapi/
│   └── cure-agent.v1.json            # BE에서 fetch 동기화, 직접 편집 금지(CI diff 검사로 강제)
├── scripts/
│   └── generate-api.mjs
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   │   ├── login/page.tsx
│   │   │   └── signup/page.tsx
│   │   ├── (protected)/
│   │   │   ├── layout.tsx
│   │   │   ├── assistant/
│   │   │   │   ├── page.tsx
│   │   │   │   └── _components/      # 화면 전용 조립부 (라우트 콜로케이션)
│   │   │   ├── guidelines/
│   │   │   │   ├── page.tsx
│   │   │   │   ├── [guidelineId]/page.tsx
│   │   │   │   └── _components/
│   │   │   ├── patients/
│   │   │   │   ├── page.tsx
│   │   │   │   ├── [patientId]/page.tsx
│   │   │   │   └── _components/
│   │   │   └── history/
│   │   │       ├── page.tsx
│   │   │       ├── [conversationId]/page.tsx
│   │   │       └── _components/
│   │   ├── error.tsx / loading.tsx / not-found.tsx
│   │   └── providers.tsx
│   │
│   ├── widgets/                      # 실제로 2개 이상 화면에서 재사용되는 것만
│   │   ├── app-shell/
│   │   └── evidence-inspector/       # /assistant, /guidelines 공용
│   │
│   ├── features/
│   │   ├── auth/                     # login + signup + logout 통합
│   │   ├── ask-guideline/
│   │   ├── filter-guidelines/
│   │   ├── inspect-evidence/
│   │   ├── manage-patient/
│   │   ├── request-clinical-guidance/
│   │   ├── review-clinical-guidance/
│   │   ├── manage-conversation/
│   │   └── submit-answer-feedback/
│   │
│   └── shared/
│       ├── api/
│       │   ├── generated/            # schema.ts, client.ts
│       │   ├── http.ts               # 전송 계층
│       │   ├── api-client.ts         # 봉투 해석·언랩 계층
│       │   ├── api-error.ts
│       │   ├── stream-client.ts      # SSE (http.ts의 refresh 경로 공유)
│       │   └── query-client.ts
│       ├── auth/ config/ lib/ ui/ test/
│
├── package.json
└── next.config.ts
```

의존 방향: `app → widgets → features → shared` (단방향 고정).

**API 계층 원칙:**

- `http.ts`는 순수 전송 계층: URL 빌드, `credentials: "include"`, **401 → refresh 단일화(single-flight 공유 promise) → 원 요청 1회 재시도**까지만 담당. 봉투 규약은 모른다.
- 로그아웃·리다이렉트 정책은 `setUnauthorizedHandler(handler)` 주입으로 분리 — 전송 계층을 상태관리에 결합시키지 않는다.
- openapi-fetch에는 이 로직을 middleware로 이식한다.
- **stream-client도 동일한 `ensureRefreshed()`를 공유한다.** 스트리밍 요청도 토큰 만료를 만난다.
- 봉투 해석(`success`/`code` 분기, 언랩)은 `api-client.ts`가 담당.

FE 전용 타입(폼 값, 스트리밍 중간 상태, ViewModel)은 feature 내부 `model/`에 둔다. 별도 entities/ 레이어는 만들지 않는다. 스트리밍 상태는 TanStack Query와 궁합이 나쁘므로 `ask-guideline/model/stream-state.model.ts`에서 useReducer(또는 zustand)로 관리한다.

**테스트**: `*.test.ts` colocation. API 모킹은 OpenAPI 스키마 기반 MSW 핸들러(`shared/test/`).

---

## 3. cure-agent-be 구조

```
cure-agent-be/
├── docs/
│   ├── architecture.md               # 설계 원본 (이 문서)
│   └── specs/                        # 작업 단위 스펙 — 구현 순서 5단계부터, 스텝당 1페이지 (§15)
├── .claude/commands/implement.md     # 구현 하네스 — 구현 순서 4단계에서 작성 (§15)
├── openapi/cure-agent.v1.json
├── drizzle/migrations/               # 불변 원칙: 적용된 파일 수정 금지
├── scripts/
│   ├── export-openapi.ts
│   └── ingest-guidelines.ts
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   │
│   ├── global/
│   │   ├── config/
│   │   ├── context/                  # nestjs-cls: 요청당 traceId(ULID) 발급·전파
│   │   ├── database/
│   │   │   ├── database.module.ts
│   │   │   ├── database.provider.ts
│   │   │   ├── transaction-manager.ts
│   │   │   └── base-columns.ts       # createdAt/updatedAt 공통 column helper
│   │   ├── common/
│   │   │   ├── response/             # api-response.dto, page-meta.dto, interceptor, decorator
│   │   │   ├── exception/
│   │   │   │   ├── error-code.registry.ts    # (status, code, message) 단일 소스
│   │   │   │   ├── service.exception.ts
│   │   │   │   └── api-exception.filter.ts   # 레지스트리만 참조해 봉투 생성
│   │   │   ├── cursor/               # 불투명 base64url 커서 인코딩/디코딩
│   │   │   ├── guard/ decorator/ pipe/
│   │   ├── security/
│   │   │   ├── auth-cookie.factory.ts        # 쿠키 발급·만료 팩토리
│   │   │   ├── token-resolver.ts             # 쿠키 → 토큰 추출
│   │   │   ├── jwt-auth.guard.ts             # + @CurrentClinician 데코레이터
│   │   │   ├── token-denylist.service.ts     # access 즉시 무효화 (Redis, §4.3)
│   │   │   ├── csrf.guard.ts                 # 상태 변경 요청의 커스텀 헤더 검증
│   │   │   └── crypto/
│   │   │       ├── aes-gcm.util.ts           # 필드 암호화
│   │   │       ├── hmac-index.util.ts        # 검색용 blind index
│   │   │       └── crypto.config.ts          # 키/키버전 관리 (환경변수 → 추후 KMS)
│   │   ├── observability/
│   │   │   ├── real-time-alert.sender.ts     # 5xx·LLM 장애 Discord/Slack 알림
│   │   │   ├── ignorable-exception.classifier.ts  # 클라이언트 abort 등 필터링
│   │   │   └── logging/                      # 프롬프트 원문 마스킹 규칙 포함
│   │   ├── redis/
│   │   │   └── redis.module.ts               # denylist(§4.3) + 이후 캐시(§11) 공용 클라이언트
│   │   ├── openapi/
│   │   └── cache/
│   │
│   ├── domain/
│   │   ├── auth/
│   │   ├── clinician/
│   │   ├── patient/
│   │   ├── guideline/
│   │   ├── conversation/
│   │   ├── clinical-guidance/
│   │   └── evaluation/               # P1
│   │
│   └── infrastructure/
│       ├── llm/
│       │   ├── llm-gateway.ts
│       │   ├── llm-provider.port.ts          # 포트 유지 (fake 테스트·교체 실요구 있음)
│       │   ├── openai-provider.ts
│       │   ├── anthropic-provider.ts
│       │   ├── provider-router.ts            # 우선순위·폴백 라우팅
│       │   ├── retry-policy.ts
│       │   ├── circuit-breaker.ts            # 연속 실패 시 차단
│       │   ├── rate-limit-block-store.ts     # 429 감지 시 일정시간 호출 차단
│       │   └── response-cache.ts             # 규칙은 §11
│       ├── embedding/                        # 포트 유지
│       ├── retrieval/                        # 포트 유지
│       ├── document/                         # pdf-parser, guideline-chunker
│       └── scheduler/                        # P1
│
├── test/
│   ├── contract/                     # OpenAPI 재생성 diff + breaking change 검사
│   └── e2e/                          # Testcontainers 기반 (§13)
└── package.json
```

**도메인 내부 (경량화 확정):**

```
domain/patient/
├── patient.module.ts
├── controller/patient.controller.ts
├── service/patient.service.ts
├── entity/patient.entity.ts
├── dto/request/ dto/response/
├── repository/patient.repository.ts   # Drizzle 구현 단일 클래스 — 인터페이스 없음
├── persistence/patient.schema.ts
└── mapper/patient.mapper.ts           # 실제 필요한 변환만
```

역할 분리:

- Controller: HTTP, 인증, DTO 입출력
- Service: 유스케이스와 트랜잭션
- Entity: 비즈니스 상태와 규칙
- Repository: PostgreSQL(Drizzle) 구현 단일 클래스
- Persistence schema: DB 테이블 정의
- Mapper: 필요한 변환만 (Entity ↔ row ↔ Response DTO 3방향을 기계적으로 전부 만들지 않음)

원칙:

- **포트(인터페이스) 추상화는 `llm`/`embedding`/`retrieval`에만 둔다.** fake 대역과 프로바이더 교체가 실제 요구사항인 곳이다. 일반 CRUD 도메인은 구현 1개짜리 인터페이스를 만들지 않는다 — 필요해지는 시점에 추출한다.
- Entity에 Swagger 데코레이터를 붙이거나 Entity를 컨트롤러에서 직접 반환하지 않는다.
- 각 NestJS Module은 필요한 서비스만 export해 도메인의 외부 공개 경계를 유지한다.
- ORM은 Drizzle. PostgreSQL + pgvector가 핵심이며, Drizzle은 vector 타입과 HNSW/IVFFlat 인덱스를 공식 지원하고 마이그레이션에서 `CREATE EXTENSION vector`를 직접 관리할 수 있다.
- 전 테이블에 `base-columns.ts`의 createdAt/updatedAt을 일괄 적용한다.

---

## 4. 인증·보안 설계

### 4.1 쿠키 정책

```ts
// global/security/auth-cookie.factory.ts
@Injectable()
export class AuthCookieFactory {
  // COOKIE_SECURE: dev=false, prod=true
  // COOKIE_DOMAIN: dev=""(host-only), prod=운영 도메인
  issueAccess(token: string): ResponseCookie   // access_token,  HttpOnly, Secure, SameSite=Lax, Path=/
  issueRefresh(token: string): ResponseCookie  // refresh_token, HttpOnly, Secure, SameSite=Lax, Path=/
  expireAccess(): ResponseCookie               // maxAge=0
  expireRefresh(): ResponseCookie
}
```

- **XSS 대응**: 토큰은 HttpOnly 쿠키로만 존재 — JS에서 접근 불가. FE 코드·스토리지에 토큰이 등장하지 않는다.
- **CSRF 대응**: `SameSite=Lax` + 상태 변경 요청(POST/PATCH/DELETE)에 커스텀 헤더 `X-CSRF-Protection: 1`을 요구하는 `csrf.guard.ts`. 커스텀 헤더는 cross-origin form/단순 요청으로 위조할 수 없다. SSE POST 요청에도 동일 적용. FE는 http.ts와 stream-client가 자동 부착.
- 로컬 개발: domain 미지정 host-only 쿠키.

### 4.2 인증 API

| API | 동작 |
|---|---|
| `POST /auth/signup` | 가입 + 즉시 로그인 처리, Set-Cookie로 access/refresh 발급 |
| `POST /auth/login` | 검증 후 Set-Cookie 발급, 바디에는 `AuthSessionResponseDto`(토큰 미포함) |
| `POST /auth/logout` | `token-resolver`로 토큰 추출 → 서버측 세션 revoke → 만료 쿠키 발급 |
| `POST /auth/refresh` | refresh 쿠키 검증 → access 재발급 + refresh rotation |
| `GET /auth/me` | 세션 복구 |
| `GET /auth/email-availability` | **rate limit 적용** (이메일 열거 공격 표면) |

refresh는 GET이 아닌 **POST**를 사용한다(멱등이 아니고 프리페치 오발동 위험).

### 4.3 Refresh rotation + 재사용 감지

- `AuthSessionEntity`: `refreshTokenHash`, `familyId`, `rotatedAt`, `revokedAt`, `reuseDetectedAt`
- refresh 토큰은 JWT가 아닌 불투명 랜덤값(쿠키: `sessionId.secret`)이며 DB에는 sha256 해시만 저장한다. **원본 저장소는 PostgreSQL** — 재사용 감지가 "회전된 토큰의 이력"을 요구하므로 TTL 소멸형 저장소(Redis)를 원본으로 쓰지 않는다.
- refresh 성공 시 새 refresh 발급, 구 토큰은 rotated 처리. **rotated된 구 토큰이 다시 사용되면 탈취로 간주하고 해당 family 전체 세션 폐기** + 실시간 알림.
- 인증 가드는 `JwtAuthGuard` + `@CurrentClinician()` 데코레이터.

**access 토큰 즉시 무효화 (Redis denylist):**

- access JWT는 `sub`, `clinicId`, `sid`(세션), `fid`(family) claim을 갖는다.
- 로그아웃·재사용 감지 시 `auth:deny:fid:{familyId}` 키를 **access TTL + 여유분** 동안 기록 → 해당 로그인 체인의 모든 access 토큰이 TTL이 남아 있어도 즉시 거부된다.
- `JwtAuthGuard`는 서명·만료 검증(무DB) 후 denylist만 확인한다. 정상 경로의 추가 비용은 Redis EXISTS 1회.
- **Redis 장애 시 fail-open** + 실시간 알림(5분 dedupe): 기본 보안선은 access TTL(≤15분)이며 denylist는 방어 계층이다. Redis는 가용성 필수 의존성이 아니다(lazyConnect, 오프라인 큐 비활성).
- Redis의 역할: denylist(현재) → 응답 캐시(§11)·기타 캐싱(이후 필요 시) 공용.

### 4.4 멀티테넌시 스코프 강제

- 규칙: **patient / conversation / clinical-guidance / feedback의 모든 조회·변경은 요청자의 clinic 스코프로 필터링한다.** 서비스 코드의 선의에 맡기지 않는다.
- 강제 방법: repository 메서드 시그니처가 스코프를 필수 인자로 받는다.

```ts
findById(scope: ClinicScope, patientId: string): Promise<Patient | null>
// scope 없이 호출할 수 있는 public 메서드를 만들지 않는다
```

- 타 스코프 리소스는 403이 아닌 **404로 응답**(존재 여부 자체를 숨김).
- e2e 필수 케이스: "다른 클리닉의 환자/대화/가이던스 접근 → 404".

### 4.5 민감정보 필드 암호화

- **AES-GCM 필드 암호화** (`aes-gcm.util.ts`): 대상 — `licenseNumber`, `clinicalNotes`, `diagnoses`, `medications`, `allergies`. Drizzle custom column helper(`encryptedText()`)로 도메인 코드에서 투명하게 처리.
- **HMAC blind index** (`hmac-index.util.ts`): 암호화 필드 중 검색이 필요한 것은 HMAC 인덱스 컬럼을 병행한다.
- 키 관리: `crypto.config.ts`에서 키+키버전 관리(환경변수 시작, KMS 이관 대비). 키버전을 암호문에 포함해 로테이션 가능하게.
- **PatientProfileSnapshot의 immutable JSON에도 동일 암호화 적용** + 보존 기간 정책 명시(예: 마지막 접근 후 N년).
- **LLM 외부 전송**: 환자 데이터가 프롬프트로 외부 API에 나간다. provider의 zero-retention 정책 확인을 운영 체크리스트에 포함한다. 로그에는 프롬프트 원문을 남기지 않는다(마스킹) — `GenerationRun`에는 프롬프트 "버전"만 기록.
- 공개 포트폴리오 데모에서는 실제 이름 대신 `CASE-001` 같은 비식별 식별자를 사용한다. 건강정보는 개인정보보호법상 민감정보다.

---

## 5. 화면과 API 매핑

API prefix는 `/api/v1`로 통일한다.

### 5.1 로그인 화면 `/login`

| 기능 | API | Request DTO | Response data DTO |
|---|---|---|---|
| 이메일 로그인 | POST /auth/login | LoginRequestDto | AuthSessionResponseDto (+Set-Cookie) |
| 현재 사용자 복구 | GET /auth/me | 없음 | ClinicianResponseDto |
| 세션 갱신 | POST /auth/refresh | HttpOnly Cookie | AuthSessionResponseDto (+Set-Cookie) |

### 5.2 회원가입 화면 `/signup`

| 기능 | API | Request DTO | Response data DTO |
|---|---|---|---|
| 의료인 가입(+로그인) | POST /auth/signup | SignUpRequestDto | AuthSessionResponseDto (+Set-Cookie) |
| 이메일 중복 확인 | GET /auth/email-availability | EmailAvailabilityQueryDto | EmailAvailabilityResponseDto |

로그아웃은 보호된 전체 화면에서 사용: `POST /auth/logout` → `ApiResponseDto<null>` + 만료 쿠키.

### 5.3 지침 질의 화면 `/assistant`

PC 기준 핵심 화면. 레이아웃: 대화/세션 목록 | 질문과 스트리밍 답변 | 인용 근거 패널

| 기능 | API | Request DTO | Response data DTO |
|---|---|---|---|
| 검색 대상 지침 조회 | GET /guidelines | ListGuidelinesQueryDto | GuidelineSummaryResponseDto[] |
| 새 대화 생성 | POST /conversations | CreateConversationRequestDto | ConversationSummaryResponseDto |
| 기존 대화 조회 | GET /conversations/{id} | 없음 | ConversationDetailResponseDto |
| 질문 및 스트리밍 | POST /conversations/{id}/messages/stream | SendMessageRequestDto | SSE 이벤트 (§8) |
| 인용 원문 조회 | GET /evidence/{evidenceId} | 없음 | EvidenceDetailResponseDto |
| 답변 평가 | POST /messages/{messageId}/feedback | SubmitFeedbackRequestDto | null |

### 5.4 지침 탐색 화면 `/guidelines`

| 기능 | API | Request DTO | Response data DTO |
|---|---|---|---|
| 지침 검색·필터 | GET /guidelines | ListGuidelinesQueryDto | GuidelineSummaryResponseDto[] |
| 지침 상세 | GET /guidelines/{guidelineId} | 없음 | GuidelineDetailResponseDto |
| 섹션·권고문 조회 | GET /guidelines/{id}/evidence | ListEvidenceQueryDto | EvidenceSummaryResponseDto[] |
| 근거 상세 | GET /evidence/{evidenceId} | 없음 | EvidenceDetailResponseDto |

원문 PDF는 직접 재배포하지 않고 `sourceUrl`로 NCKM 원문을 연결한다.

### 5.5 환자 목록 화면 `/patients`

| 기능 | API | Request DTO | Response data DTO |
|---|---|---|---|
| 환자 검색·목록 | GET /patients | ListPatientsQueryDto | PatientSummaryResponseDto[] |
| 환자 프로필 등록 | POST /patients | CreatePatientRequestDto | PatientDetailResponseDto |
| 환자 보관 | POST /patients/{id}/archive | 없음 | null |
| 환자 보관 해제 | POST /patients/{id}/unarchive | 없음 | null |

### 5.6 환자 상세·임상 참고 화면 `/patients/[patientId]`

| 기능 | API | Request DTO | Response data DTO |
|---|---|---|---|
| 환자 상세 조회 | GET /patients/{id} | 없음 | PatientDetailResponseDto |
| 프로필 수정 | PATCH /patients/{id} | UpdatePatientRequestDto | PatientDetailResponseDto |
| 환자 기반 대화 생성 | POST /conversations | CreateConversationRequestDto | ConversationSummaryResponseDto |
| 근거 기반 가이드 생성 | POST /conversations/{id}/messages/stream | SendMessageRequestDto | SSE 이벤트 (§8) |
| 의료인 검토 기록 | POST /clinical-guidance/{id}/reviews | ReviewClinicalGuidanceRequestDto | ClinicalGuidanceResponseDto |

"처방 추천"을 확정 처방으로 표현하지 않는다. 결과 상태: `DRAFT → ACCEPTED | MODIFIED | REJECTED`

### 5.7 대화 히스토리 화면 `/history`

PC에서는 목록과 상세를 한 화면에 배치한다.

| 기능 | API | Request DTO | Response data DTO |
|---|---|---|---|
| 대화 목록 조회 | GET /conversations | ListConversationsQueryDto | ConversationSummaryResponseDto[] |
| 대화 상세 | GET /conversations/{id} | 없음 | ConversationDetailResponseDto |
| 메시지 페이지 조회 | GET /conversations/{id}/messages | ListMessagesQueryDto | MessageResponseDto[] |
| 대화명 변경 | PATCH /conversations/{id} | UpdateConversationRequestDto | ConversationSummaryResponseDto |
| 대화 보관 | POST /conversations/{id}/archive | 없음 | null |
| 대화 보관 해제 | POST /conversations/{id}/unarchive | 없음 | null |
| 이어서 질문 | POST /conversations/{id}/messages/stream | SendMessageRequestDto | SSE 이벤트 (§8) |

**과거 답변 재현성**: 텍스트만 보관하지 않는다. 당시 사용된 다음 정보를 함께 고정한다 — 인용 지침 버전, Evidence chunk ID, 환자 프로필 snapshot ID, 프롬프트 버전, 검색 정책 버전, 모델·생성 설정. 지침이나 환자 정보가 변경돼도 "당시 왜 이 답이 나왔는지" 재현할 수 있어야 한다.

**공통**: 전 목록 API는 불투명 base64url 커서 + `PageMetaDto`. **totalCount 없음이 확정 사양** — 화면에 "총 N건"을 표시하지 않는다.

---

## 6. 주요 Request DTO

계약 형태이며 BE에서는 class + class-validator로 작성한다.

```ts
class SignUpRequestDto {
  email: string;
  password: string;
  displayName: string;
  clinicName: string;
  licenseNumber: string;
  termsAccepted: boolean;
}

class LoginRequestDto {
  email: string;
  password: string;
}

class CreatePatientRequestDto {
  caseLabel: string;
  birthYear?: number;
  sex?: "MALE" | "FEMALE" | "OTHER" | "UNKNOWN";
  heightCm?: number;
  weightKg?: number;
  waistCm?: number;
  diagnoses: string[];
  medications: string[];
  allergies: string[];
  clinicalNotes?: string;
}

class UpdatePatientRequestDto extends PartialType(CreatePatientRequestDto) {
  version: number; // 낙관적 잠금
}

class ListPatientsQueryDto {
  query?: string;
  status?: "ACTIVE" | "ARCHIVED";
  cursor?: string;
  size?: number;
}

class ListGuidelinesQueryDto {
  query?: string;
  status?: "ACTIVE" | "SUPERSEDED";
  publisher?: string;
  cursor?: string;
  size?: number;
}

class GuidelineSearchFilterDto {
  guidelineIds?: string[];
  recommendationGrades?: string[];
  evidenceLevels?: string[];
}

class CreateConversationRequestDto {
  type: "GUIDELINE_QA" | "PATIENT_GUIDANCE";
  patientId?: string;
  title?: string;
}

class SendMessageRequestDto {
  content: string;
  filters?: GuidelineSearchFilterDto;
  clientRequestId: string; // 중복 생성 방지
}

class ListConversationsQueryDto {
  type?: "GUIDELINE_QA" | "PATIENT_GUIDANCE";
  patientId?: string;
  query?: string;
  cursor?: string;
  size?: number;
}

class ReviewClinicalGuidanceRequestDto {
  decision: "ACCEPTED" | "MODIFIED" | "REJECTED";
  note?: string;
}

class SubmitFeedbackRequestDto {
  rating: "HELPFUL" | "NOT_HELPFUL";
  reasonCodes?: string[];
  comment?: string;
}
```

`clientRequestId`에는 unique constraint를 걸어 네트워크 재시도 시 같은 질문이 두 번 생성되지 않게 한다.

---

## 7. 주요 Response DTO

```ts
class ClinicianResponseDto {
  id: string;
  email: string;
  displayName: string;
  clinic: ClinicSummaryResponseDto;
  verificationStatus: "PENDING" | "VERIFIED" | "REJECTED";
}

class AuthSessionResponseDto {
  clinician: ClinicianResponseDto;
  expiresAt: string;
}
```

환자:

```ts
class PatientSummaryResponseDto {
  id: string;
  caseLabel: string;
  age?: number;
  sex?: string;
  bmi?: number;
  status: "ACTIVE" | "ARCHIVED";
  updatedAt: string;
}

class PatientDetailResponseDto extends PatientSummaryResponseDto {
  birthYear?: number;
  heightCm?: number;
  weightKg?: number;
  waistCm?: number;
  diagnoses: string[];
  medications: string[];
  allergies: string[];
  clinicalNotes?: string;
  version: number;
}
```

지침과 근거:

```ts
class RatingResponseDto {
  system: string; // GRADE 등
  code: string;
  label: string;
}

class GuidelineSummaryResponseDto {
  id: string;
  title: string;
  publisher: string;
  currentVersion: string;
  publishedAt: string;
  status: "ACTIVE" | "SUPERSEDED";
}

class EvidenceDetailResponseDto {
  id: string;
  guidelineId: string;
  guidelineVersionId: string;
  guidelineTitle: string;
  version: string;
  sectionPath: string[];
  recommendationNumber?: string;
  recommendationText?: string;
  recommendationGrade?: RatingResponseDto;
  evidenceLevel?: RatingResponseDto;
  excerpt: string;
  pageStart?: number;
  pageEnd?: number;
  sourceUrl: string;
}
```

등급을 단순 enum `A | B | C`로 고정하지 않는 이유: 문서마다 권고등급 체계가 다를 수 있다.

대화와 인용:

```ts
class AnswerCitationResponseDto {
  marker: number;
  evidenceId: string;
  guidelineTitle: string;
  guidelineVersion: string;
  sectionPath: string[];
  quote: string;
  sourceUrl: string;
}

class MessageResponseDto {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  status: "STREAMING" | "COMPLETED" | "ABSTAINED" | "FAILED" | "CANCELLED";
  answerKind: "GUIDELINE_ANSWER" | "CLINICAL_GUIDANCE";
  citations: AnswerCitationResponseDto[];
  createdAt: string;
}

class ConversationSummaryResponseDto {
  id: string;
  type: "GUIDELINE_QA" | "PATIENT_GUIDANCE";
  title: string;
  patient?: PatientSummaryResponseDto;
  lastMessagePreview?: string;
  updatedAt: string;
}

class ConversationDetailResponseDto extends ConversationSummaryResponseDto {
  createdAt: string;
}
```

`CANCELLED`는 클라이언트 abort·타임아웃으로 중단된 메시지 상태다. `STREAMING`으로 영원히 남는 좀비 메시지를 없애기 위해 존재한다.

임상 참고 결과:

```ts
class GuidanceConsiderationResponseDto {
  title: string;
  rationale: string;
  citations: AnswerCitationResponseDto[];
}

class SafetyAlertResponseDto {
  severity: "INFO" | "WARNING" | "CRITICAL";
  description: string;
  citations: AnswerCitationResponseDto[];
}

class ClinicalGuidanceResponseDto {
  id: string;
  patientId: string;
  patientProfileSnapshotId: string;
  summary: string;
  considerations: GuidanceConsiderationResponseDto[];
  safetyAlerts: SafetyAlertResponseDto[];
  missingInformation: string[];
  reviewStatus: "DRAFT" | "ACCEPTED" | "MODIFIED" | "REJECTED";
  generatedAt: string;
}
```

---

## 8. SSE 스트리밍 계약

SSE에는 공통 `ApiResponseDto`를 씌우지 않는다. `text/event-stream` 자체가 여러 이벤트를 연속 전달하는 계약이다. POST 스트리밍은 브라우저 EventSource를 쓸 수 없으므로 FE는 `fetch()` + ReadableStream으로 처리한다.

```ts
type ConversationStreamEventDto =
  | {
      eventType: "message.accepted";          // 첫 이벤트: 복구의 기준점
      requestId: string;                       // clientRequestId 대응
      userMessageId: string;
      assistantMessageId: string;
    }
  | { eventType: "retrieval.started"; requestId: string }
  | { eventType: "retrieval.completed"; evidence: EvidenceDetailResponseDto[] }
  | {
      eventType: "answer.delta";
      messageId: string;
      seq: number;                             // 순서·중복 감지
      delta: string;
    }
  | { eventType: "answer.completed"; message: MessageResponseDto; guidance?: ClinicalGuidanceResponseDto }
  | { eventType: "answer.abstained"; message: MessageResponseDto; reason: string; missingInformation: string[] }
  | {
      eventType: "error";
      code: string;                            // 에러코드 레지스트리 참조 (§10)
      message: string;
      retryable: boolean;
      traceId: string;
    };
```

**전송 규약:**

- **Heartbeat**: 15~30초 간격 SSE 주석(`: ping`) 전송 — 프록시 idle timeout으로 LLM이 느린 날 스트림이 끊기는 것을 방지. 응답 헤더에 `X-Accel-Buffering: no`, `Cache-Control: no-cache`.
- `error` 이벤트 후 서버는 스트림을 닫는다. `answer.completed`/`answer.abstained`가 정상 종결 이벤트다.

**끊김 복구 계약 (필수 사양):**

1. POST 스트림은 자동 재연결이 없다. 스트림이 비정상 종료되면 FE는 `GET /conversations/{id}/messages`로 최종 상태를 조회한다 — `message.accepted`에서 받은 `assistantMessageId`가 기준점.
2. 해당 메시지가 `COMPLETED`/`ABSTAINED`면 그 내용으로 확정 렌더. `STREAMING`/`FAILED`/`CANCELLED`면 재시도 UI 제공.
3. 재시도는 같은 `clientRequestId`로 안전하다(unique constraint가 중복 생성을 차단).
4. 클라이언트 abort 감지 시 서버는 LLM 호출을 취소하고 메시지를 `CANCELLED`로 정리한다.
5. LLM 응답 타임아웃(권장 60~120s) 초과 시 `error(retryable: true)` 발행 후 `FAILED` 처리.

**OpenAPI 표현**: oneOf + discriminator(`eventType`). Nest Swagger 생성기가 완전히 표현하지 못하는 부분은 `@ApiProduces('text/event-stream')` + 수동 schema 또는 OpenAPI overlay로 보완한다.

---

## 9. BE Entity 설계

| Entity | 주요 필드 및 관계 |
|---|---|
| ClinicEntity | id, name, createdAt |
| ClinicianEntity | id, clinicId, email, passwordHash, displayName, **licenseNumber(AES-GCM 암호화)**, verificationStatus |
| AuthSessionEntity | id, clinicianId, refreshTokenHash, **familyId, rotatedAt, reuseDetectedAt**, expiresAt, revokedAt |
| PatientEntity | id, clinicId, caseLabel, 신체정보, **병력·약물·알레르기·노트(AES-GCM 암호화, 검색 필드는 HMAC index 병행)**, version, status |
| PatientProfileSnapshotEntity | 가이드 생성 당시 환자 정보를 immutable JSON으로 저장 (**암호화 + 보존 기간 정책**) |
| GuidelineEntity | id, title, publisher, status |
| GuidelineVersionEntity | guidelineId, version, publishedAt, sourceUrl, contentHash |
| GuidelineSectionEntity | guidelineVersionId, parentId, title, path, order |
| EvidenceChunkEntity | sectionId, content, embedding, 권고등급, 근거수준, 페이지, contentHash |
| IngestionRunEntity | 파싱·청킹·임베딩 실행 결과 및 실패 사유 |
| ConversationEntity | clinicianId, patientId?, type, title, status |
| MessageEntity | conversationId, role, content, status(**CANCELLED 포함**) |
| MessageCitationEntity | messageId, evidenceChunkId, marker, quote |
| GenerationRunEntity | 모델, **실사용 프로바이더**, 프롬프트 버전, retrieval 버전, latency, token usage, traceId |
| ClinicalGuidanceEntity | messageId, patientSnapshotId, 생성 결과, reviewStatus |
| GuidanceReviewEntity | guidanceId, clinicianId, decision, note |
| AnswerFeedbackEntity | messageId, 평가, 사유, 코멘트 |
| EvaluationRunEntity | 평가셋·설정·전체 지표 (P1) |
| EvaluationCaseResultEntity | 질문별 retrieval/citation 결과 (P1) |

전 Entity에 createdAt/updatedAt 공통 컬럼 적용. 다음 참조 체인은 반드시 보존한다:

```
ClinicalGuidance
 ├── PatientProfileSnapshot
 ├── GenerationRun
 ├── Message
 └── MessageCitation[] → EvidenceChunk → GuidelineVersion
```

---

## 10. 공통 응답 + 에러코드 레지스트리

### 10.1 응답 봉투

일반 JSON API는 다음 형식으로 통일한다.

```ts
class ApiResponseDto<T> {
  success: boolean;
  code: string;
  message: string;
  data: T | null;
  page: PageMetaDto | null;
  timestamp: string;
  traceId: string;
}

class PageMetaDto {
  size: number;
  hasNext: boolean;
  nextCursor: string | null;
}
```

성공 예:

```json
{
  "success": true,
  "code": "PATIENT_FETCHED",
  "message": "환자 프로필을 조회했습니다.",
  "data": { "id": "patient-id", "caseLabel": "CASE-001", "bmi": 27.4, "version": 3 },
  "page": null,
  "timestamp": "2026-07-23T14:00:00.000Z",
  "traceId": "01J..."
}
```

실패 예:

```json
{
  "success": false,
  "code": "PATIENT_VERSION_CONFLICT",
  "message": "다른 사용자가 환자 정보를 먼저 수정했습니다.",
  "data": { "currentVersion": 4 },
  "page": null,
  "timestamp": "2026-07-23T14:00:00.000Z",
  "traceId": "01J..."
}
```

운영 규칙:

- 실패를 HTTP 200으로 반환하지 않는다. `success=false`와 함께 실제 400/401/403/404/409/422/429/500/503 사용.
- code는 FE 분기용으로 안정적으로 유지, message는 사용자 표시용, traceId는 로그·응답 연결용.
- 목록은 `data: T[]` + `page: PageMetaDto`. 생성 API는 HTTP 201 + envelope.
- SSE·파일 다운로드에는 envelope 미적용.

TypeScript generic은 런타임 reflection에서 구체 타입을 잃으므로 `ApiResponseDto<T>` 선언만으로는 OpenAPI의 data 타입이 생성되지 않는다. `ApiExtraModels` + `getSchemaPath` + `allOf`를 사용하는 `@ApiEnvelopeResponse(Model)` 데코레이터를 만들어 OpenAPI에 `ApiResponse<PatientDetailResponseDto>` 형태로 구체화해 기록한다. FE는 이를 그대로 생성하므로 수동 `interfaces/response`를 유지하지 않는다.

### 10.2 에러코드 레지스트리 — 단일 소스

```ts
// global/common/exception/error-code.registry.ts
export const ErrorCodes = {
  // 공통
  BAD_REQUEST:                { status: 400, message: "적절하지 않은 요청입니다." },
  UNAUTHORIZED:               { status: 401, message: "인증이 필요합니다." },
  FORBIDDEN:                  { status: 403, message: "권한이 없습니다." },
  CSRF_REJECTED:              { status: 403, message: "요청 출처를 확인할 수 없습니다. 새로고침 후 다시 시도해주세요." },
  NOT_FOUND:                  { status: 404, message: "대상을 찾을 수 없습니다." },
  VALIDATION_FAILED:          { status: 422, message: "입력값이 올바르지 않습니다." },
  RATE_LIMITED:               { status: 429, message: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." },
  INTERNAL_ERROR:             { status: 500, message: "서버 내부 오류가 발생했습니다." },
  // Auth
  AUTH_INVALID_CREDENTIALS:   { status: 401, message: "이메일 또는 비밀번호가 올바르지 않습니다." },
  AUTH_TOKEN_EXPIRED:         { status: 401, message: "만료된 토큰입니다." },
  AUTH_REFRESH_REUSED:        { status: 401, message: "세션이 무효화되었습니다. 다시 로그인해주세요." },
  AUTH_EMAIL_ALREADY_USED:    { status: 409, message: "이미 사용중인 이메일입니다." },
  // Patient
  PATIENT_VERSION_CONFLICT:   { status: 409, message: "다른 사용자가 환자 정보를 먼저 수정했습니다." },
  PATIENT_ARCHIVED:           { status: 409, message: "보관된 환자입니다. 먼저 보관을 해제해주세요." },
  // Conversation / LLM
  DUPLICATE_CLIENT_REQUEST:   { status: 409, message: "이미 처리 중인 요청입니다." },
  LLM_UNAVAILABLE:            { status: 503, message: "AI 응답 생성이 지연되고 있습니다. 잠시 후 다시 시도해주세요." },
  // Guidance
  GUIDANCE_ALREADY_REVIEWED:  { status: 409, message: "이미 검토가 완료된 항목입니다." },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ErrorCodes;
```

- 코드 네이밍은 **의미식**(`PATIENT_VERSION_CONFLICT`)으로 통일한다.
- `ServiceException`은 `ErrorCode`만 받는다. **서비스 코드에 code 문자열 리터럴 등장 금지.**
- `api-exception.filter.ts`는 레지스트리만 참조해 상태·봉투를 생성한다. ValidationPipe 오류는 `VALIDATION_FAILED`(422) + 필드 상세를 data에, 예상 밖 예외는 `INTERNAL_ERROR`(500)로 같은 봉투에 수렴시킨다.
- 실패 응답의 보조 데이터는 data에 싣는다 (예: `PATIENT_VERSION_CONFLICT` → `{ currentVersion: 4 }`).
- 성공 code/message도 `success-code.registry.ts`에서 같은 방식으로 관리한다(기본 `SUCCESS`, 화면 분기가 필요한 코드는 도메인 단계에서 추가).

### 10.3 traceId

- `global/context/`에서 nestjs-cls(AsyncLocalStorage)로 요청당 ULID 발급.
- 모든 로그 라인·응답 봉투·SSE error 이벤트에 동일 traceId 바인딩.

### 10.4 커서 페이지네이션

- 커서는 **불투명 base64url 인코딩** — 내부 정렬키를 계약에 노출하지 않는다.
- `PageMetaDto { size, hasNext, nextCursor }`를 전 목록 API에 강제.

---

## 11. LLM 인프라 안정성

`retry-policy` 단독으로는 부족하다. `infrastructure/llm/`에 4단 방어를 구성한다:

1. **retry-policy**: 일시 오류(5xx, 네트워크)에 지수 백오프 재시도. 타임아웃 명시(연결 10s / 전체 60~120s).
2. **circuit-breaker**: 연속 실패 임계 초과 시 일정 시간 호출 차단(fail-fast). 차단 중 요청은 즉시 `LLM_UNAVAILABLE`.
3. **rate-limit-block-store**: 429 수신 시 해당 프로바이더를 `Retry-After` 기준 일정 시간 차단.
4. **provider-router**: 우선순위 기반 폴백 라우팅 — 주 프로바이더 차단·실패 시 보조 프로바이더로 전환. `GenerationRun`에 실사용 프로바이더·모델 기록.

**response-cache 규칙 (확정):**

- 캐시 키 = 정규화된 질문 + **지침 버전 세트 + 프롬프트 버전 + 검색 정책 버전**. 버전이 하나라도 다르면 미스.
- **환자 컨텍스트(PATIENT_GUIDANCE)가 섞인 요청은 캐시 금지.** 지침 QA(GUIDELINE_QA)만 대상.

LLM 장애는 real-time-alert로 즉시 알림 (§14).

---

## 12. 데이터·마이그레이션·검색

- **마이그레이션 불변 원칙**: 한번 적용된 마이그레이션 파일 수정 금지, baseline부터 순번 관리. `CREATE EXTENSION vector`는 초기 마이그레이션에서 관리.
- **pgvector 인덱스 전략**: MVP 규모(지침 수십 개, chunk 수천~수만)에서는 **인덱스 없이 exact search로 시작**한다 — 더 정확하고 충분히 빠르다. HNSW/IVFFlat은 측정 후 도입.
- **hybrid search (P1 백로그)**: 한국어 의료 용어는 임베딩 단독 검색이 약할 수 있다. tsvector 키워드 검색 + 벡터 검색 결합을 P1로 등록.

---

## 13. 테스트 전략

**BE:**

- `test/e2e`: Testcontainers로 `pgvector/pgvector` 실DB 기동. LLM/embedding은 **포트 덕분에 fake provider로 치환** — 포트를 llm 계열에만 유지하는 이유가 이것이다.
- e2e 필수 시나리오:
  - 타 클리닉 리소스 접근 → 404 (§4.4)
  - refresh rotation·재사용 감지 → family 전체 폐기 + 같은 family의 access 토큰 즉시 차단
  - 로그아웃 → TTL이 남은 access 토큰 즉시 무효화 (denylist)
  - `clientRequestId` 중복 요청 → 단일 생성
  - SSE: 정상 완료 / abstain / 중단 후 `GET messages` 복구 / abort → `CANCELLED`
  - 낙관적 잠금 → `PATIENT_VERSION_CONFLICT` + currentVersion
- `test/contract`: ① 커밋된 `cure-agent.v1.json`과 코드 재생성본의 diff = 0 검사, ② openapi-diff로 breaking change 감지.

**FE:**

- `*.test.ts` colocation, API 모킹은 OpenAPI 스키마 기반 MSW.
- stream-client는 ReadableStream 모의로 delta 순서·복구 흐름 단위 테스트.

---

## 14. 관측·운영

- **실시간 장애 알림**: 5xx·LLM 실패·circuit open·refresh 재사용 감지를 Discord/Slack webhook으로 즉시 알림. `ignorable-exception.classifier`로 클라이언트 abort 등 무시 가능 예외는 제외.
- **로깅**: 전 로그 traceId 바인딩. **프롬프트 원문·환자 데이터는 로그 금지(마스킹)**. `GenerationRun`에 latency·token usage 축적 (Prometheus `/metrics` 노출은 P1).
- **CI**: lint + test + **gitleaks 시크릿 스캔(1일차부터)** + OpenAPI export·diff 검사.

---

## 15. 구현 순서

1. **global 기반 일괄 구축**: 응답 봉투 + 에러코드 레지스트리 + 예외 필터 + nestjs-cls traceId + config + base-columns + crypto util + alert sender — 나중에 끼우면 전 도메인 리팩토링이 된다
2. Auth·Clinician: AuthCookieFactory, JwtAuthGuard, CSRF 가드, refresh rotation
3. **OpenAPI export + FE codegen CI 파이프라인** — 이후 모든 FE 작업이 생성 타입 위에서 돌게 한다
4. **구현 하네스·SDD 도입**: `.claude/commands/implement.md` 하네스(spec 읽기 → 계획 → e2e 테스트 작성·동결 → 구현 → 테스트·contract diff 통과 → PR)와 `docs/specs/` 디렉토리 구성. 1~3단계는 이 문서가 직접 스펙이므로 하네스 없이 구현하고, **5단계부터는 스텝당 1페이지 spec을 먼저 작성한 뒤 하네스로 구현한다**
5. Guideline·Evidence + 인제스트 (exact search)
6. Conversation·Message + SSE + LLM 게이트웨이(4단 방어 포함)
7. FE 공통: http 전송 계층(단일화 refresh) + app-shell + 로그인
8. 지침 질의 3단 화면
9. Patient + PatientProfileSnapshot (필드 암호화·스코프 강제 포함)
10. ClinicalGuidance + 의료인 검토
11. History
12. 운영 마감: 실시간 알림 연결, e2e 크로스테넌트·SSE 복구 시나리오, gitleaks·contract CI 확인

### 5단계 이후 작업 규칙 (SDD)

각 스텝은 구현 전에 `docs/specs/NN-<이름>.md`를 작성한다. 스펙은 1페이지를 유지하고, 이 문서와 중복되는 내용은 §링크로만 참조한다.

```markdown
# NN. <스텝 이름>
## 범위: 엔드포인트 목록 (URI·DTO는 architecture.md §5~§7 참조 — 복사 금지)
## Entity/마이그레이션 변경분
## 추가 에러코드
## 수용 기준: 동결할 e2e 시나리오 목록 (= Definition of Done)
## Out of scope
```

수용 기준의 e2e 테스트는 **구현 전에 작성해 동결**하고, 구현은 동결된 테스트를 통과시키는 방식으로 진행한다. 구현 중 테스트 수정 금지 — 스펙 결함을 발견하면 spec을 먼저 고치고 테스트를 다시 동결한다.

**교차 작성 원칙**: 수용 기준 테스트는 **구현 에이전트(Claude)와 분리된 작성자(Codex)** 가 스펙에서 독립 파생한다 — 같은 에이전트가 심판과 선수를 모두 만들면 스펙 오독이 테스트·구현 양쪽에 복제되는 것을 막는 교차 검증 장치다. Claude는 리뷰(커버리지·공허 통과·스펙 외 가정)와 동결만 담당하고 assertion을 직접 수정하지 않는다. Codex 불가 시 Claude 단독 폴백(동결 커밋에 명시). 절차 상세는 `.claude/commands/implement.md` Phase 2.

핵심은 다음 경계를 지키는 것이다:

```
BE Entity
   ↓ mapper
BE Response DTO
   ↓ OpenAPI
FE generated DTO
   ↓ feature ViewModel
FE UI
```

---

## 부록: 초안 대비 주요 개정 이력

| # | 변경 |
|---|---|
| 1 | 에러코드 레지스트리 신설 (`ErrorCodes` 단일 소스, 의미식 네이밍, 리터럴 금지) |
| 2 | 인증을 쿠키 팩토리 패턴으로 구체화 + CSRF 가드 + refresh rotation·재사용 감지 + FE 단일화 refresh |
| 3 | clinic 스코프를 repository 시그니처로 강제, 타 스코프 404, e2e 필수화 |
| 4 | SSE에 `message.accepted`·seq·heartbeat·끊김 복구 계약·`CANCELLED` 상태 추가 |
| 5 | AES-GCM + HMAC blind index 필드 암호화, 스냅샷 암호화·보존 정책, 프롬프트 로그 마스킹 |
| 6 | LLM 4단 방어(재시도·서킷브레이커·rate-limit 차단·폴백 라우팅), 캐시 규칙 확정 |
| 7 | 실시간 장애 알림, traceId(nestjs-cls), Testcontainers, base-columns, gitleaks, 불투명 커서 |
| 8 | CRUD 도메인의 repository 인터페이스 제거 (포트는 llm/embedding/retrieval만) |
| 9 | FE features의 auth 통합, widgets는 app-shell·evidence-inspector만, workspace는 라우트 콜로케이션 |
| 10 | pgvector exact search로 시작, 인덱스는 측정 후, hybrid search P1 |
| 11 | archive에 대응하는 unarchive API 추가, enum 전방 호환 규칙, OpenAPI 동기화 방법 확정 |
| 12 | codegen CI를 구현 순서 3단계로 전진, 1단계에 레지스트리·traceId·필터 포함 |
| 13 | 구현 순서 4단계에 SDD 하네스(implement.md + docs/specs/) 도입, 5단계 이후 spec 선행·테스트 동결 규칙 명시 |
| 14 | Redis 도입: access 토큰 즉시 무효화 denylist(`fid` claim, fail-open) — refresh 원본 저장소는 PostgreSQL 유지, Redis는 denylist+캐시 용도 |
| 15 | 계약 동기화 자동화: BE `openapi/**` push → FE repository_dispatch → 자동 동기화 PR, breaking은 동기화 PR typecheck 실패로 표면화 |
| 16 | cron 폴백 제거 — push 단독 동기화로 확정, 토큰 부재·만료는 contract-notify hard-fail로 감지 |
| 17 | SDD 테스트 교차 작성: 동결 테스트는 Codex가 스펙에서 독립 파생, Claude는 리뷰·동결·구현 담당 (8단계부터 적용, Codex 불가 시 Claude 폴백) |
