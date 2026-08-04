import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { clinicInvitationConfig } from '../../global/config/clinic-invitation.config';
import { ClinicOwnerGuard } from '../../global/security/clinic-owner.guard';
import { AuthSessionModule } from '../auth/auth-session.module';
import { ClinicInvitationController } from './controller/clinic-invitation.controller';
import { ClinicMemberController } from './controller/clinic-member.controller';
import { InvitationPreviewController } from './controller/invitation-preview.controller';
import { ClinicInvitationRepository } from './repository/clinic-invitation.repository';
import { ClinicMemberRemovalRepository } from './repository/clinic-member-removal.repository';
import { ClinicianRepository } from './repository/clinician.repository';
import { ClinicInvitationService } from './service/clinic-invitation.service';
import { ClinicMemberService } from './service/clinic-member.service';

@Module({
  // 강퇴가 대상의 전 세션을 끊는다 (docs/specs/38) — AuthModule 전체가 아니라 세션 저장소만
  // 가져온다. 저쪽이 이 모듈을 import하므로 AuthModule을 들이면 순환이다.
  imports: [ConfigModule.forFeature(clinicInvitationConfig), AuthSessionModule],
  controllers: [ClinicInvitationController, InvitationPreviewController, ClinicMemberController],
  providers: [
    ClinicianRepository,
    ClinicInvitationRepository,
    ClinicMemberRemovalRepository,
    ClinicInvitationService,
    ClinicMemberService,
    ClinicOwnerGuard,
  ],
  // 합류 경로(auth)가 초대 해석·소비를 요구한다 (docs/specs/35)
  exports: [ClinicianRepository, ClinicInvitationService],
})
export class ClinicianModule {}
