import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ulid } from 'ulid';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { authConfig } from '../../../global/config/auth.config';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { MetricsService } from '../../../global/observability/metrics/metrics.service';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { TokenDenylistService } from '../../../global/security/token-denylist.service';
import { AuthSessionRepository } from '../../auth/repository/auth-session.repository';
import { TransferClinicOwnerRequestDto } from '../dto/request/transfer-clinic-owner.request.dto';
import { ClinicMemberResponseDto } from '../dto/response/clinic-member.response.dto';
import { ClinicInvitationRepository } from '../repository/clinic-invitation.repository';
import { ClinicMemberRemovalRepository } from '../repository/clinic-member-removal.repository';
import { ClinicianRepository } from '../repository/clinician.repository';

@Injectable()
export class ClinicMemberService {
  constructor(
    private readonly clinicians: ClinicianRepository,
    private readonly invitations: ClinicInvitationRepository,
    private readonly removals: ClinicMemberRemovalRepository,
    private readonly sessions: AuthSessionRepository,
    private readonly txManager: TransactionManager,
    private readonly tokenDenylist: TokenDenylistService,
    private readonly metrics: MetricsService,
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
  ) {}

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

  /**
   * 구성원 강퇴 (docs/specs/38) — §35 초대의 반대 방향이다.
   *
   * **강퇴는 소속만 끊는다.** 계정도 그 안의 개인정보도 그 사람의 것이므로 개설자가 파기하지
   * 않는다 — §36 탈퇴(본인 의사 → 즉시 익명화)와 갈리는 지점이며, 오강퇴를 되돌릴 수 있는
   * 이유이기도 하다(다시 초대하면 **같은 계정으로** 복귀한다).
   *
   * **순서가 계약이다:** 대상 검증 → 자기 자신 차단 → familyIds 조회 →
   * tx(이력 → 소속 해제 → 발급한 유효 초대 취소 → 전 세션 폐기) → denylist.
   * 판정이 UPDATE보다 앞서야 409로 끝날 요청이 소속을 먼저 끊지 않는다(기준 17).
   */
  async remove(principal: ClinicianPrincipal, clinicianId: string): Promise<null> {
    const target = await this.clinicians.findMemberInClinic(principal.clinicId, clinicianId);
    // 타 클리닉이거나 이미 탈퇴한 tombstone이면 0행이다 — 둘 다 404로 수렴시킨다 (§4.4)
    if (!target) throw new ServiceException('NOT_FOUND');

    // 개설자가 자신을 빼면 그 클리닉은 owner가 없어져 영구히 초대를 발급할 수 없는 잠긴
    // 상태가 된다(§35). §36이 `CLINIC_OWNER_MUST_TRANSFER`로 막은 것과 같은 사고다.
    if (target.id === principal.clinicianId) {
      this.metrics.recordClinicMemberRemoval('blocked');
      throw new ServiceException('CLINIC_OWNER_CANNOT_REMOVE_SELF');
    }

    const now = new Date(Date.now());
    // denylist는 family 단위라 폐기 대상 family를 **끊기 전에** 확보한다 (§36 탈퇴와 동형)
    const familyIds = await this.sessions.findFamilyIdsByClinician(target.id);

    const revokedInvitations = await this.txManager.run(async () => {
      await this.removals.insert({
        id: ulid(),
        clinicId: principal.clinicId,
        removedClinicianId: target.id,
        removedByClinicianId: principal.clinicianId,
      });

      // 조건부 UPDATE가 0행이면 그 사이 누가 먼저 뺐다는 뜻이므로 같은 404로 수렴시킨다
      const detached = await this.clinicians.detachFromClinic(principal.clinicId, target.id);
      if (!detached) throw new ServiceException('NOT_FOUND');

      const revoked = await this.invitations.revokeAllByInviter(
        principal.clinicId,
        target.id,
        now,
      );
      await this.sessions.revokeAllByClinician(target.id, now);
      return revoked;
    });

    // 트랜잭션 밖인 이유는 Redis가 롤백 대상이 아니고, 실패해도 DB 폐기는 이미 확정이기
    // 때문이다 (§36 탈퇴와 같은 형태). denylist가 없으면 TTL이 남은 access 토큰이 통과한다.
    await Promise.all(
      familyIds.map((familyId) =>
        this.tokenDenylist.denyFamily(familyId, this.config.accessTtlSec),
      ),
    );

    // 자동 취소분도 초대의 종말이므로 §35 카운터에 합류시킨다 — 라벨을 쪼개면 대시보드가 갈린다
    for (let index = 0; index < revokedInvitations; index += 1) {
      this.metrics.recordClinicInvitation('revoked');
    }
    this.metrics.recordClinicMemberRemoval('removed');
    return null;
  }
}
