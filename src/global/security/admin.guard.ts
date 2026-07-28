import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * ADMIN 역할 가드 (docs/specs/21).
 *
 * **역할은 access 토큰 페이로드에서 읽지 않고 DB에서 조회한다.** 토큰에 박으면 권한 회수가
 * access TTL만큼 지연되고 §4.3의 rotation 설계를 건드리게 된다. 관리 엔드포인트는 트래픽이
 * 없어 요청당 조회 1회가 무해하다.
 *
 * 앞단의 전역 `JwtAuthGuard`가 미인증을 401로 거르므로, 이 가드는 역할만 본다.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  // TODO(docs/specs/21): 스텁 — 역할 조회는 구현 단계에서 채운다
  canActivate(_context: ExecutionContext): Promise<boolean> {
    return Promise.resolve(true);
  }
}
