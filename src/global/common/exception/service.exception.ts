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
  ) {
    super(ErrorCodes[code].message);
    this.name = 'ServiceException';
  }

  get status(): number {
    return ErrorCodes[this.code].status;
  }
}
