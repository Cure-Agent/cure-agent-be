import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ClinicianRepository } from '../../domain/clinician/repository/clinician.repository';
import { ServiceException } from '../common/exception/service.exception';
import { ClinicianPrincipal } from './clinician-principal';

/**
 * 개설자 가드 (docs/specs/35) — 초대 발급·조회·취소는 `clinics.ownerClinicianId` 한 사람만이다.
 *
 * **`AdminGuard`와 다른 축이다.** 저것은 플랫폼 관리 권한(`clinicians.role`)이고 이것은 병원 내
 * 권한이다. 한 컬럼이 두 가지를 뜻하지 않도록 스펙이 분리했다.
 *
 * 역할과 마찬가지로 access 토큰에서 읽지 않고 요청당 DB를 본다(§21 관행) — 개설자 이양·구성원
 * 제거가 생겨도 권한 회수가 access TTL만큼 지연되지 않는다. 초대 관리 경로는 트래픽이 없다.
 * 앞단의 전역 `JwtAuthGuard`가 미인증을 401로 거르므로 여기서는 소유권만 본다.
 */
@Injectable()
export class ClinicOwnerGuard implements CanActivate {
  constructor(private readonly clinicians: ClinicianRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { clinician?: ClinicianPrincipal }>();
    const principal = request.clinician;
    if (!principal) throw new ServiceException('UNAUTHORIZED');

    const ownerId = await this.clinicians.findClinicOwnerId(principal.clinicId);
    if (ownerId === null || ownerId !== principal.clinicianId) {
      throw new ServiceException('FORBIDDEN');
    }
    return true;
  }
}
