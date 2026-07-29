import { ErrorCode, ErrorCodes } from './error-code.registry';

/**
 * 도메인 서비스가 던지는 유일한 예외 타입.
 * code 외의 상태·메시지는 전부 레지스트리에서 파생된다.
 */
export class ServiceException extends Error {
  constructor(
    readonly code: ErrorCode,
    /** 실패 응답 봉투의 data에 실리는 보조 정보 (예: { currentVersion: 4 }) */
    readonly data?: unknown,
    /**
     * 로그·CLI용 상세 메시지. **응답 봉투에는 쓰이지 않는다** —
     * 봉투의 message는 언제나 레지스트리에서 온다(`api-exception.filter.ts`).
     * 사용자에게 보일 문구와 운영자가 볼 진단을 분리하기 위한 자리다.
     */
    detail?: string,
  ) {
    super(detail ?? ErrorCodes[code].message);
    this.name = 'ServiceException';
  }

  get status(): number {
    return ErrorCodes[this.code].status;
  }
}
