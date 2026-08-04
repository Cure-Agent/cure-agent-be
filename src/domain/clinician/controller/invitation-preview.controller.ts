import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiEnvelopeResponse } from '../../../global/common/response/api-envelope.decorator';
import { Public } from '../../../global/security/public.decorator';
import { ClinicInvitationPreviewResponseDto } from '../dto/response/clinic-invitation-preview.response.dto';
import { ClinicInvitationService } from '../service/clinic-invitation.service';

/**
 * 초대 프리뷰 (docs/specs/35) — **비인증**이다. 초대받은 사람은 아직 계정이 없다.
 * 인증 리소스(`/clinic/invitations`)와 경로를 분리해 가드 적용 범위가 한눈에 갈리게 한다.
 */
@ApiTags('ClinicInvitation')
@Controller('invitations')
export class InvitationPreviewController {
  constructor(private readonly invitationService: ClinicInvitationService) {}

  @Get(':token')
  @Public()
  @ApiOperation({ summary: '초대 프리뷰 (비인증) — 한의원명만 반환한다' })
  @ApiEnvelopeResponse(ClinicInvitationPreviewResponseDto)
  preview(@Param('token') token: string): Promise<ClinicInvitationPreviewResponseDto> {
    return this.invitationService.preview(token);
  }
}
