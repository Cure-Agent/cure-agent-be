import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiEnvelopeResponse } from '../../../global/common/response/api-envelope.decorator';
import { ClinicOwnerGuard } from '../../../global/security/clinic-owner.guard';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { CurrentClinician } from '../../../global/security/current-clinician.decorator';
import { TransferClinicOwnerRequestDto } from '../dto/request/transfer-clinic-owner.request.dto';
import { ClinicMemberResponseDto } from '../dto/response/clinic-member.response.dto';
import { ClinicMemberService } from '../service/clinic-member.service';

/**
 * 클리닉 구성원 (docs/specs/36).
 *
 * 가드가 경로마다 다르다 — 목록은 **전원**, 이양은 **개설자 전용**이다. 이양 대상을 고르려면
 * 목록이 먼저 열려야 하므로 둘을 같은 가드로 묶을 수 없다.
 */
@ApiTags('ClinicMember')
@Controller('clinic')
export class ClinicMemberController {
  constructor(private readonly memberService: ClinicMemberService) {}

  @Get('members')
  @ApiOperation({ summary: '클리닉 구성원 목록 (전원 조회 — 탈퇴자 제외)' })
  @ApiEnvelopeResponse(ClinicMemberResponseDto, { isArray: true })
  list(@CurrentClinician() principal: ClinicianPrincipal): Promise<ClinicMemberResponseDto[]> {
    return this.memberService.list(principal);
  }

  @Post('owner/transfer')
  @HttpCode(200)
  @UseGuards(ClinicOwnerGuard)
  @ApiOperation({ summary: '개설자 권한 이양 (개설자 전용)' })
  transferOwner(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Body() dto: TransferClinicOwnerRequestDto,
  ): Promise<null> {
    return this.memberService.transferOwner(principal, dto);
  }

  /**
   * 구성원 강퇴 (docs/specs/38) — 초대의 반대 방향이다. 이양과 같은 개설자 게이트를 쓴다.
   * 소속만 끊으므로 대상의 계정·개인정보는 남는다.
   */
  @Delete('members/:clinicianId')
  @HttpCode(200)
  @UseGuards(ClinicOwnerGuard)
  @ApiOperation({ summary: '구성원 강퇴 — 소속 해제 (개설자 전용)' })
  remove(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('clinicianId') clinicianId: string,
  ): Promise<null> {
    return this.memberService.remove(principal, clinicianId);
  }
}
