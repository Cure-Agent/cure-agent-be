import { Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiEnvelopeResponse,
  ApiPageResponse,
} from '../../../global/common/response/api-envelope.decorator';
import { ApiResponseDto } from '../../../global/common/response/api-response.dto';
import { PageResult } from '../../../global/common/response/page-result';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { CurrentClinician } from '../../../global/security/current-clinician.decorator';
import { ListClinicInvitationsQueryDto } from '../dto/request/list-clinic-invitations.query.dto';
import { ClinicInvitationIssuedResponseDto } from '../dto/response/clinic-invitation-issued.response.dto';
import { ClinicInvitationResponseDto } from '../dto/response/clinic-invitation.response.dto';
import { ClinicInvitationService } from '../service/clinic-invitation.service';

/** 초대 관리 (docs/specs/35) — 전 경로가 **개설자 전용**(`clinics.ownerClinicianId`)이다. */
@ApiTags('ClinicInvitation')
@Controller('clinic/invitations')
export class ClinicInvitationController {
  constructor(private readonly invitationService: ClinicInvitationService) {}

  @Post()
  @ApiOperation({ summary: '초대 발급 (개설자 전용) — 토큰은 이 응답에서만 노출된다' })
  @ApiEnvelopeResponse(ClinicInvitationIssuedResponseDto, { status: 201 })
  async issue(
    @CurrentClinician() principal: ClinicianPrincipal,
  ): Promise<ApiResponseDto<ClinicInvitationIssuedResponseDto>> {
    const issued = await this.invitationService.issue(principal);
    return ApiResponseDto.success(issued, 'CREATED');
  }

  @Get()
  @ApiOperation({ summary: '초대 목록 (개설자 전용) — 토큰은 실리지 않는다' })
  @ApiPageResponse(ClinicInvitationResponseDto)
  list(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Query() query: ListClinicInvitationsQueryDto,
  ): Promise<PageResult<ClinicInvitationResponseDto>> {
    return this.invitationService.list(principal, query);
  }

  @Delete(':invitationId')
  @ApiOperation({ summary: '초대 취소 (개설자 전용)' })
  revoke(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('invitationId') invitationId: string,
  ): Promise<null> {
    return this.invitationService.revoke(principal, invitationId);
  }
}
