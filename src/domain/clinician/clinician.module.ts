import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { clinicInvitationConfig } from '../../global/config/clinic-invitation.config';
import { ClinicOwnerGuard } from '../../global/security/clinic-owner.guard';
import { ClinicInvitationController } from './controller/clinic-invitation.controller';
import { InvitationPreviewController } from './controller/invitation-preview.controller';
import { ClinicInvitationRepository } from './repository/clinic-invitation.repository';
import { ClinicianRepository } from './repository/clinician.repository';
import { ClinicInvitationService } from './service/clinic-invitation.service';

@Module({
  imports: [ConfigModule.forFeature(clinicInvitationConfig)],
  controllers: [ClinicInvitationController, InvitationPreviewController],
  providers: [
    ClinicianRepository,
    ClinicInvitationRepository,
    ClinicInvitationService,
    ClinicOwnerGuard,
  ],
  // 합류 경로(auth)가 초대 해석·소비를 요구한다 (docs/specs/35)
  exports: [ClinicianRepository, ClinicInvitationService],
})
export class ClinicianModule {}
