/** JwtAuthGuard가 access 토큰 claims에서 복원해 request에 싣는 인증 주체. */
export interface ClinicianPrincipal {
  clinicianId: string;
  clinicId: string;
  sessionId: string;
}

/** §4.4 멀티테넌시 스코프 — patient/conversation 계열 repository의 필수 인자 타입. */
export interface ClinicScope {
  clinicianId: string;
  clinicId: string;
}
