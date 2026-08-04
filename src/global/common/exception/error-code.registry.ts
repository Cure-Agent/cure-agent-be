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

  // 회원탈퇴 (docs/specs/36) — 개설자가 떠나려면 먼저 넘겨야 한다.
  // owner를 NULL로 두면 그 클리닉은 영구히 초대를 발급할 수 없는 잠긴 상태가 된다(§35가 발급·조회·
  // 취소 전부를 owner에 묶었다). 마지막 구성원은 넘길 상대가 없으므로 이 코드에 걸리지 않는다.
  CLINIC_OWNER_MUST_TRANSFER: {
    status: 409,
    message: '개설자는 먼저 다른 구성원에게 권한을 넘겨야 탈퇴할 수 있습니다.',
  },

  // 클리닉 초대 (docs/specs/35)
  // 만료·사용됨·취소됨·존재하지 않음을 **하나로 뭉친다** — 상태를 구분해 알려주면 유출된 토큰에
  // 대해 「이건 실재하는 초대였다」를 확인해주는 셈이다(§4.4 「존재 여부 자체를 숨김」과 같은 이유).
  // 문구가 다음 행동(재요청)을 담으므로 UX 손실은 없다.
  INVITATION_INVALID: {
    status: 404,
    message: '유효하지 않거나 만료된 초대 링크입니다. 개설자에게 새 링크를 요청해주세요.',
  },

  // Patient
  PATIENT_VERSION_CONFLICT: { status: 409, message: '다른 사용자가 환자 정보를 먼저 수정했습니다.' },
  PATIENT_ARCHIVED: { status: 409, message: '보관된 환자입니다. 먼저 보관을 해제해주세요.' },

  // Conversation / LLM
  DUPLICATE_CLIENT_REQUEST: { status: 409, message: '이미 처리 중인 요청입니다.' },
  // 전 프로바이더 소진·상류 장애. "지연"은 LLM_TIMEOUT의 몫이라 문구를 분리했다 —
  // 예전엔 이 코드가 retrieval 이후 모든 실패(DB 오류 포함)를 뭉뚱그려 진단을 막았다.
  LLM_UNAVAILABLE: {
    status: 503,
    message: 'AI 응답 생성을 일시적으로 이용할 수 없습니다. 잠시 후 다시 시도해주세요.',
  },
  // 스트림 전체 상한(§8-5) 초과 — 상류는 살아 있으나 제한 시간 안에 끝나지 않았다.
  // 504가 아닌 이유: §10.1 허용 status 집합에 없다. 구분은 status가 아니라 code가 진다.
  LLM_TIMEOUT: {
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

  // Guideline 코퍼스 관리 (docs/specs/21)
  GUIDELINE_VERSION_CITED: {
    status: 409,
    message: '이미 인용된 지침 버전은 삭제할 수 없습니다. 폐기를 사용해주세요.',
  },
  // data에 §20 가드가 잡은 권고 번호를 싣는다 — 없으면 어디를 고쳐야 하는지 알 수 없다.
  GUIDELINE_PARSE_FAILED: { status: 422, message: '지침을 파싱하지 못했습니다.' },
  GUIDELINE_SOURCE_UNAVAILABLE: { status: 502, message: '지침 원본을 가져오지 못했습니다.' },

  // 지침 전건 잡 (docs/specs/22)
  GUIDELINE_JOB_ALREADY_RUNNING: { status: 409, message: '이미 실행 중인 지침 잡이 있습니다.' },
  GUIDELINE_JOB_NOT_RUNNING: {
    status: 409,
    message: '실행 중이 아닌 잡은 취소할 수 없습니다.',
  },
  // 상류 실패라 502다 (§10.1) — 지금은 임베딩 실패가 INTERNAL_ERROR(500)로 흘러
  // 우리 코드의 결함과 구분되지 않는다.
  GUIDELINE_EMBEDDING_FAILED: { status: 502, message: '지침 임베딩에 실패했습니다.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ErrorCodes;
