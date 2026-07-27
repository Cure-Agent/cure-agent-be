/**
 * 에러코드 단일 소스 (architecture.md §10.2)
 *
 * - 서비스 코드에 code 문자열 리터럴 등장 금지 — 반드시 ServiceException(ErrorCode)로만 사용한다.
 * - code는 FE 분기용 계약이므로 한번 배포된 이름은 변경하지 않는다.
 */
export const ErrorCodes = {
  // 공통
  BAD_REQUEST: { status: 400, message: '적절하지 않은 요청입니다.' },
  UNAUTHORIZED: { status: 401, message: '인증이 필요합니다.' },
  FORBIDDEN: { status: 403, message: '권한이 없습니다.' },
  CSRF_REJECTED: {
    status: 403,
    message: '요청 출처를 확인할 수 없습니다. 새로고침 후 다시 시도해주세요.',
  },
  NOT_FOUND: { status: 404, message: '대상을 찾을 수 없습니다.' },
  VALIDATION_FAILED: { status: 422, message: '입력값이 올바르지 않습니다.' },
  RATE_LIMITED: { status: 429, message: '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.' },
  INTERNAL_ERROR: { status: 500, message: '서버 내부 오류가 발생했습니다.' },

  // Auth
  AUTH_TOKEN_EXPIRED: { status: 401, message: '만료된 토큰입니다.' },
  AUTH_REFRESH_REUSED: { status: 401, message: '세션이 무효화되었습니다. 다시 로그인해주세요.' },
  AUTH_EMAIL_ALREADY_USED: {
    status: 409,
    message: '이미 다른 소셜 계정으로 가입된 이메일입니다.',
  },

  // Auth — 소셜 로그인 (docs/specs/17)
  // 콜백 경로의 실패는 JSON이 아니라 로그인 페이지 `?error=<code>`로 전달된다.
  AUTH_OAUTH_PROVIDER_UNSUPPORTED: {
    status: 400,
    message: '지원하지 않는 소셜 로그인 제공자입니다.',
  },
  AUTH_OAUTH_STATE_MISMATCH: {
    status: 400,
    message: '로그인 요청이 만료되었습니다. 다시 시도해주세요.',
  },
  AUTH_OAUTH_DENIED: { status: 400, message: '소셜 로그인 동의가 취소되었습니다.' },
  AUTH_OAUTH_FAILED: { status: 401, message: '소셜 로그인에 실패했습니다. 다시 시도해주세요.' },
  AUTH_OAUTH_EMAIL_MISSING: {
    status: 400,
    message: '가입에는 이메일이 필요합니다. 이메일 제공에 동의해주세요.',
  },
  AUTH_OAUTH_TICKET_INVALID: {
    status: 401,
    message: '가입 정보가 만료되었습니다. 처음부터 다시 로그인해주세요.',
  },

  // Patient
  PATIENT_VERSION_CONFLICT: { status: 409, message: '다른 사용자가 환자 정보를 먼저 수정했습니다.' },
  PATIENT_ARCHIVED: { status: 409, message: '보관된 환자입니다. 먼저 보관을 해제해주세요.' },

  // Conversation / LLM
  DUPLICATE_CLIENT_REQUEST: { status: 409, message: '이미 처리 중인 요청입니다.' },
  LLM_UNAVAILABLE: {
    status: 503,
    message: 'AI 응답 생성이 지연되고 있습니다. 잠시 후 다시 시도해주세요.',
  },

  // Ops (docs/specs/16)
  SERVICE_NOT_READY: {
    status: 503,
    message: '서비스가 아직 준비되지 않았습니다.',
  },

  // Guidance
  GUIDANCE_ALREADY_REVIEWED: { status: 409, message: '이미 검토가 완료된 항목입니다.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ErrorCodes;
