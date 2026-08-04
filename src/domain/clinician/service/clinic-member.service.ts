import { Injectable } from '@nestjs/common';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { TransferClinicOwnerRequestDto } from '../dto/request/transfer-clinic-owner.request.dto';
import { ClinicMemberResponseDto } from '../dto/response/clinic-member.response.dto';
import { ClinicianRepository } from '../repository/clinician.repository';

@Injectable()
export class ClinicMemberService {
  constructor(private readonly clinicians: ClinicianRepository) {}

  /**
   * 구성원 목록 — 전원 조회 가능(docs/specs/36). 환자·대화를 전원 공유하면서(§35) 동료가
   * 누구인지 모르는 상태가 더 이상하다. tombstone은 리포지토리에서 걸러진다.
   */
  async list(principal: ClinicianPrincipal): Promise<ClinicMemberResponseDto[]> {
    const [members, ownerId] = await Promise.all([
      this.clinicians.listMembers(principal.clinicId),
      this.clinicians.findClinicOwnerId(principal.clinicId),
    ]);

    return members.map((member) => ({
      id: member.id,
      displayName: member.displayName,
      isOwner: member.id === ownerId,
      joinedAt: member.createdAt.toISOString(),
    }));
  }

  /**
   * 개설자 이양 — 대상은 **같은 클리닉의 살아 있는 구성원**이어야 한다. 타 클리닉이거나
   * tombstone이면 0행이라 미존재와 구분되지 않고, 둘 다 404다 (§4.4 존재 은닉).
   *
   * 자기 자신을 지정하면 그대로 통과한다 — 결과가 「내가 개설자」로 같으므로 멱등이다.
   */
  async transferOwner(
    principal: ClinicianPrincipal,
    dto: TransferClinicOwnerRequestDto,
  ): Promise<null> {
    const target = await this.clinicians.findMemberInClinic(
      principal.clinicId,
      dto.toClinicianId,
    );
    if (!target) throw new ServiceException('NOT_FOUND');

    await this.clinicians.updateClinicOwner(principal.clinicId, target.id);
    return null;
  }
}
