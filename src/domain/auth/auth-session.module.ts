import { Module } from '@nestjs/common';
import { AuthSessionRepository } from './repository/auth-session.repository';

/**
 * refresh 세션 저장소만 담는 얇은 모듈 (docs/specs/38).
 *
 * `AuthModule`이 `ClinicianModule`을 import하므로(합류 경로가 초대 해석을 쓴다, §35), 강퇴가
 * 세션을 끄려고 clinician 쪽에서 `AuthModule`을 import하면 **순환**이 된다. 저장소만 떼어
 * 양쪽이 함께 import한다 — 이 모듈은 전역 `TransactionManager` 외에 아무것도 의존하지 않아
 * 어느 방향으로도 순환이 생길 수 없다.
 *
 * 강퇴가 세션을 끄는 것은 선택이 아니다: 소속만 끊고 세션을 남기면 강퇴당한 사람의 access
 * 토큰이 TTL 동안 살아 있어 그 클리닉의 환자·대화를 계속 읽는다.
 */
@Module({
  providers: [AuthSessionRepository],
  exports: [AuthSessionRepository],
})
export class AuthSessionModule {}
