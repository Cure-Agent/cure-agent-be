import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiEnvelopeResponse,
  ApiPageResponse,
} from '../../../global/common/response/api-envelope.decorator';
import { ApiResponseDto } from '../../../global/common/response/api-response.dto';
import { PageResult } from '../../../global/common/response/page-result';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { CurrentClinician } from '../../../global/security/current-clinician.decorator';
import { CreatePatientRequestDto } from '../dto/request/create-patient.request.dto';
import { ListPatientsQueryDto } from '../dto/request/list-patients.query.dto';
import { UpdatePatientRequestDto } from '../dto/request/update-patient.request.dto';
import { PatientDetailResponseDto } from '../dto/response/patient-detail.response.dto';
import { PatientSummaryResponseDto } from '../dto/response/patient-summary.response.dto';
import { PatientService } from '../service/patient.service';

@ApiTags('Patient')
@Controller('patients')
export class PatientController {
  constructor(private readonly patientService: PatientService) {}

  @Post()
  @ApiOperation({ summary: '환자 프로필 등록 (민감 필드 암호화 저장 §4.5)' })
  @ApiEnvelopeResponse(PatientDetailResponseDto, { status: 201 })
  async create(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Body() dto: CreatePatientRequestDto,
  ): Promise<ApiResponseDto<PatientDetailResponseDto>> {
    const created = await this.patientService.create({ clinicId: principal.clinicId }, dto);
    return ApiResponseDto.success(created, 'CREATED');
  }

  @Get()
  @ApiOperation({ summary: '환자 검색·목록 (caseLabel 부분일치, 커서 기반)' })
  @ApiPageResponse(PatientSummaryResponseDto)
  list(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Query() query: ListPatientsQueryDto,
  ): Promise<PageResult<PatientSummaryResponseDto>> {
    return this.patientService.list({ clinicId: principal.clinicId }, query);
  }

  @Get(':patientId')
  @ApiOperation({ summary: '환자 상세' })
  @ApiEnvelopeResponse(PatientDetailResponseDto)
  detail(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('patientId') patientId: string,
  ): Promise<PatientDetailResponseDto> {
    return this.patientService.detail({ clinicId: principal.clinicId }, patientId);
  }

  @Patch(':patientId')
  @ApiOperation({ summary: '환자 수정 (낙관적 잠금 — version 필수)' })
  @ApiEnvelopeResponse(PatientDetailResponseDto)
  update(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('patientId') patientId: string,
    @Body() dto: UpdatePatientRequestDto,
  ): Promise<PatientDetailResponseDto> {
    return this.patientService.update({ clinicId: principal.clinicId }, patientId, dto);
  }

  @Post(':patientId/archive')
  @HttpCode(200)
  @ApiOperation({ summary: '환자 보관' })
  archive(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('patientId') patientId: string,
  ): Promise<null> {
    return this.patientService.archive({ clinicId: principal.clinicId }, patientId);
  }

  @Post(':patientId/unarchive')
  @HttpCode(200)
  @ApiOperation({ summary: '환자 보관 해제' })
  unarchive(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('patientId') patientId: string,
  ): Promise<null> {
    return this.patientService.unarchive({ clinicId: principal.clinicId }, patientId);
  }
}
