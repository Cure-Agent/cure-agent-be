import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ClinicianRepository } from '../../domain/clinician/repository/clinician.repository';
import { ServiceException } from '../common/exception/service.exception';
import { ClinicianPrincipal } from './clinician-principal';

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
  constructor(private readonly clinicians: ClinicianRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { clinician?: ClinicianPrincipal }>();
    const principal = request.clinician;
    if (!principal) throw new ServiceException('UNAUTHORIZED');

    const role = await this.clinicians.findRoleById(principal.clinicianId);
    if (role !== 'ADMIN') throw new ServiceException('FORBIDDEN');
    return true;
  }
}
