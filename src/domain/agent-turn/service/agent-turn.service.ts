import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { MessageResponseDto } from '../../conversation/dto/response/message.response.dto';
import { AcceptAgentTurnRequestDto } from '../dto/request/accept-agent-turn.request.dto';
import { FinishAgentTurnRequestDto } from '../dto/request/finish-agent-turn.request.dto';
import { GuidelineAnswerRequestDto } from '../dto/request/guideline-answer.request.dto';
import { GuidelineEvidenceRequestDto } from '../dto/request/guideline-evidence.request.dto';
import { ResolveAgentPatientRequestDto } from '../dto/request/resolve-agent-patient.request.dto';
import { AgentPatientResolutionResponseDto } from '../dto/response/agent-patient-resolution.response.dto';
import { AgentTurnAcceptedResponseDto } from '../dto/response/agent-turn-accepted.response.dto';

/** 스텁 — docs/specs/51 구현 전 (이슈 #469) */
function notImplemented(): Error {
  return new Error('docs/specs/51 미구현');
}

/**
 * 에이전트 턴의 유스케이스 (docs/specs/51) — 수락 → 경로 도구 → 완결.
 */
@Injectable()
export class AgentTurnService {
  /** 수락 — 질문과 `STREAMING` 답변 행을 LLM보다 먼저 저장한다 */
  async accept(
    _principal: ClinicianPrincipal,
    _conversationId: string,
    _dto: AcceptAgentTurnRequestDto,
  ): Promise<AgentTurnAcceptedResponseDto> {
    throw notImplemented();
  }

  /** 지침 도구 — 채팅 파이프라인을 수락된 턴에 흘리고 그 턴에 저장한다(SSE) */
  async streamGuidelineAnswer(
    _principal: ClinicianPrincipal,
    _assistantMessageId: string,
    _dto: GuidelineAnswerRequestDto,
    _res: Response,
    _clientSignal: AbortSignal,
  ): Promise<void> {
    throw notImplemented();
  }

  /** 환자 도구 — 케이스 라벨을 해석해 스냅샷을 턴에 고정한다 */
  async resolvePatient(
    _principal: ClinicianPrincipal,
    _assistantMessageId: string,
    _dto: ResolveAgentPatientRequestDto,
  ): Promise<AgentPatientResolutionResponseDto> {
    throw notImplemented();
  }

  /** 근거 도구 — 게이트 ③까지 흘리고 저장하지 않는다(SSE) */
  async streamGuidelineEvidence(
    _principal: ClinicianPrincipal,
    _assistantMessageId: string,
    _dto: GuidelineEvidenceRequestDto,
    _res: Response,
    _clientSignal: AbortSignal,
  ): Promise<void> {
    throw notImplemented();
  }

  /** 완결 — 환자·복합·기타 경로의 턴을 닫는다 */
  async finish(
    _principal: ClinicianPrincipal,
    _assistantMessageId: string,
    _dto: FinishAgentTurnRequestDto,
  ): Promise<MessageResponseDto> {
    throw notImplemented();
  }
}
