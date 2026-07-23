import { Injectable } from '@nestjs/common';

/**
 * 실시간 알림에서 제외할 예외 판별 (architecture.md §14).
 * 클라이언트 abort·전송 중단 계열은 장애가 아니므로 알림 소음에서 제외한다.
 */
@Injectable()
export class IgnorableExceptionClassifier {
  private static readonly IGNORABLE_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);
  private static readonly IGNORABLE_MESSAGES = ['request aborted', 'premature close'];

  isIgnorable(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const code = (error as NodeJS.ErrnoException).code;
    if (code && IgnorableExceptionClassifier.IGNORABLE_CODES.has(code)) return true;

    const message = error.message.toLowerCase();
    return IgnorableExceptionClassifier.IGNORABLE_MESSAGES.some((m) => message.includes(m));
  }
}
