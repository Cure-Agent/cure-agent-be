import { Body, Controller, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiResponseDto } from '../../../global/common/response/api-response.dto';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { CurrentClinician } from '../../../global/security/current-clinician.decorator';
import { AcceptAgentTurnRequestDto } from '../dto/request/accept-agent-turn.request.dto';
import { FinishAgentTurnRequestDto } from '../dto/request/finish-agent-turn.request.dto';
import { GuidelineAnswerRequestDto } from '../dto/request/guideline-answer.request.dto';
import { GuidelineEvidenceRequestDto } from '../dto/request/guideline-evidence.request.dto';
import { ResolveAgentPatientRequestDto } from '../dto/request/resolve-agent-patient.request.dto';
import { AgentPatientResolutionResponseDto } from '../dto/response/agent-patient-resolution.response.dto';
import { AgentTurnAcceptedResponseDto } from '../dto/response/agent-turn-accepted.response.dto';
import { AgentTurnFinishResponseDto } from '../dto/response/agent-turn-finish.response.dto';
import { AgentTurnService } from '../service/agent-turn.service';

/**
 * 에이전트 전용 내부 API (docs/specs/51) — **에이전트만 부른다.**
 *
 * 사용자 쿠키로 인증하므로 공개하면 구성원이 공유 대화(§5.7)에 「AI 답변」과 인용을 지어낼 수 있다.
 * 그래서 운영 nginx가 `/api/v1/internal/`을 404로 막고(에이전트는 `http://app:3000`으로 nginx를
 * 거치지 않는다), OpenAPI에서도 뺀다 — FE 계약에 없는 경로다. 인증·스코프·CSRF 판정은 전역 가드가
 * 공개 API와 똑같이 한다.
 */
@ApiExcludeController()
@Controller('internal/agent')
export class AgentTurnInternalController {
  constructor(private readonly service: AgentTurnService) {}

  @Post('conversations/:conversationId/turns')
  async accept(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('conversationId') conversationId: string,
    @Body() dto: AcceptAgentTurnRequestDto,
  ): Promise<ApiResponseDto<AgentTurnAcceptedResponseDto>> {
    const accepted = await this.service.accept(principal, conversationId, dto);
    return ApiResponseDto.success(accepted, 'CREATED');
  }

  @Post('turns/:assistantMessageId/guideline-answer')
  async guidelineAnswer(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('assistantMessageId') assistantMessageId: string,
    @Body() dto: GuidelineAnswerRequestDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.service.streamGuidelineAnswer(
      principal,
      assistantMessageId,
      dto,
      res,
      abortOnClose(res),
    );
  }

  @Post('turns/:assistantMessageId/patient')
  @HttpCode(200)
  resolvePatient(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('assistantMessageId') assistantMessageId: string,
    @Body() dto: ResolveAgentPatientRequestDto,
  ): Promise<AgentPatientResolutionResponseDto> {
    return this.service.resolvePatient(principal, assistantMessageId, dto);
  }

  @Post('turns/:assistantMessageId/guideline-evidence')
  async guidelineEvidence(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('assistantMessageId') assistantMessageId: string,
    @Body() dto: GuidelineEvidenceRequestDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.service.streamGuidelineEvidence(
      principal,
      assistantMessageId,
      dto,
      res,
      abortOnClose(res),
    );
  }

  @Post('turns/:assistantMessageId/finish')
  @HttpCode(200)
  finish(
    @CurrentClinician() principal: ClinicianPrincipal,
    @Param('assistantMessageId') assistantMessageId: string,
    @Body() dto: FinishAgentTurnRequestDto,
  ): Promise<AgentTurnFinishResponseDto> {
    return this.service.finish(principal, assistantMessageId, dto);
  }
}

/** 클라이언트(에이전트) 이탈 감지 — 채팅 스트림 컨트롤러와 같은 방식이다 (§8-4) */
function abortOnClose(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}
