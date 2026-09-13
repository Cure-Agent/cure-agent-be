import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ulid } from 'ulid';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { TraceContext } from '../../../global/context/trace-context.service';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { SupportedLang } from '../../../infrastructure/llm/translation/translator.port';
import { MessageResponseDto } from '../../conversation/dto/response/message.response.dto';
import { ConversationRepository } from '../../conversation/repository/conversation.repository';
import {
  ConversationStreamService,
  truncateQuote,
} from '../../conversation/service/conversation-stream.service';
import { toPatientDetailFromSnapshot } from '../../patient/mapper/patient.mapper';
import { PatientSnapshotService } from '../../patient/service/patient-snapshot.service';
import { AcceptAgentTurnRequestDto } from '../dto/request/accept-agent-turn.request.dto';
import { FinishAgentTurnRequestDto } from '../dto/request/finish-agent-turn.request.dto';
import { GuidelineAnswerRequestDto } from '../dto/request/guideline-answer.request.dto';
import { GuidelineEvidenceRequestDto } from '../dto/request/guideline-evidence.request.dto';
import { ResolveAgentPatientRequestDto } from '../dto/request/resolve-agent-patient.request.dto';
import { AgentPatientResolutionResponseDto } from '../dto/response/agent-patient-resolution.response.dto';
import { AgentTurnAcceptedResponseDto } from '../dto/response/agent-turn-accepted.response.dto';
import { AgentTurnRepository, LoadedAgentTurn } from '../repository/agent-turn.repository';

/** 전역 ValidationPipe와 같은 모양으로 422 상세를 싣는다 (§10.2) */
interface FieldError {
  field: string;
  constraints: string[];
}

/**
 * 에이전트 턴의 유스케이스 (docs/specs/51) — **수락 → 경로 도구 → 완결.**
 *
 * 수락이 질문과 `STREAMING` 답변 행을 LLM보다 먼저 저장하므로 인증·스코프·CSRF·중복이 분류 비용 전에
 * 판정되고, §8 복구 기준점(`assistantMessageId`)이 채팅과 같이 선다. **턴을 닫는 주체는 경로마다
 * 하나다** — 지침은 지침 도구가 채팅 파이프라인으로, 환자·복합·기타는 에이전트의 완결이 닫는다.
 * 그래서 근거 도구·환자 도구는 턴의 상태를 바꾸지 않는다.
 */
@Injectable()
export class AgentTurnService {
  constructor(
    private readonly repository: AgentTurnRepository,
    private readonly conversationRepository: ConversationRepository,
    private readonly streamService: ConversationStreamService,
    private readonly patientSnapshotService: PatientSnapshotService,
    private readonly txManager: TransactionManager,
    private readonly traceContext: TraceContext,
  ) {}

  /**
   * 수락 — GUIDELINE_QA 대화에만 턴을 얹는다(공개 계약 diff 0).
   * PATIENT_GUIDANCE는 받지 않는다: 환자 고정·참고안 검토 흐름은 BE 채팅의 몫이다.
   */
  async accept(
    principal: ClinicianPrincipal,
    conversationId: string,
    dto: AcceptAgentTurnRequestDto,
  ): Promise<AgentTurnAcceptedResponseDto> {
    const conversation = await this.conversationRepository.findById(
      { clinicId: principal.clinicId },
      conversationId,
    );
    if (!conversation) throw new ServiceException('NOT_FOUND');
    if (conversation.type !== 'GUIDELINE_QA') {
      throw new ServiceException('BAD_REQUEST', { reason: 'AGENT_TURN_REQUIRES_GUIDELINE_QA' });
    }

    return this.streamService.acceptTurn(conversation, {
      content: dto.content,
      clientRequestId: dto.clientRequestId,
      responseLang: dto.responseLang ?? 'ko',
      // 경로가 정해지기 전이다 — 지침으로 정해져야 GUIDELINE_ANSWER가 된다 (기준 71·80)
      answerKind: null,
      // 질문에 환자 기록이 섞였는지 아직 모른다 (기준 77)
      autoTitle: false,
      withinTransaction: (accepted) =>
        this.repository.insert({
          messageId: accepted.assistantMessageId,
          userMessageId: accepted.userMessageId,
        }),
    });
  }

  /**
   * 지침 도구 — 수락된 턴에 채팅 파이프라인을 그대로 흘리고 **그 턴에** 저장한다.
   * 결과·실패·끊김의 저장 규칙이 채팅과 같아 생성 이력·인용의 출처가 BE에 남는다.
   */
  async streamGuidelineAnswer(
    principal: ClinicianPrincipal,
    assistantMessageId: string,
    dto: GuidelineAnswerRequestDto,
    res: Response,
    clientSignal: AbortSignal,
  ): Promise<void> {
    const loaded = await this.openTurn(principal, assistantMessageId);

    await this.txManager.run(async () => {
      await this.repository.recordRoute(assistantMessageId, {
        route: 'GUIDELINE',
        classifierVersion: dto.classifierVersion,
      });
      await this.conversationRepository.setAnswerKind(assistantMessageId, 'GUIDELINE_ANSWER');
      // 지침으로 정해졌으니 채팅과 같은 규칙으로 제목을 붙인다 — 수락이 미룬 몫이다 (기준 85)
      await this.streamService.applyAutoTitle(loaded.conversation, loaded.user.content);
    });

    await this.streamService.streamAnswer({
      principal,
      conversation: loaded.conversation,
      userMessageId: loaded.user.id,
      assistantMessageId,
      question: loaded.user.content,
      clientRequestId: this.requestIdOf(loaded),
      responseLang: langOf(loaded),
      res,
      clientSignal,
      // 브라우저에는 에이전트의 수락이 이미 `message.accepted`를 보냈다 (기준 78)
      announceAcceptance: false,
    });
  }

  /**
   * 환자 도구 — 케이스 라벨을 해석해 **그 읽기**로 스냅샷을 턴에 고정한다.
   *
   * 해석·고정을 한 tx에서 한다: 턴 행을 배타 잠금해 같은 턴의 동시 호출을 직렬화하고(재시도에 스냅샷이
   * 늘지 않는다), 환자 행을 공유 잠금해 고정이 끝날 때까지 그 환자의 삭제를 세운다.
   */
  async resolvePatient(
    principal: ClinicianPrincipal,
    assistantMessageId: string,
    dto: ResolveAgentPatientRequestDto,
  ): Promise<AgentPatientResolutionResponseDto> {
    await this.openTurn(principal, assistantMessageId);
    const scope = { clinicId: principal.clinicId };

    return this.txManager.run(async (): Promise<AgentPatientResolutionResponseDto> => {
      const pinnedSnapshotId = await this.repository.lockPatientSnapshotId(assistantMessageId);
      const candidates = await this.repository.findPatientsByCaseLabel(scope, dto.caseLabel.trim());
      if (candidates.length === 0) return { outcome: 'NOT_FOUND' };
      if (candidates.length > 1) return { outcome: 'AMBIGUOUS' };
      const [row] = candidates;

      if (pinnedSnapshotId) {
        // 재시도 — 이미 고정한 스냅샷을 그대로 돌려준다. 그 사이 원본이 바뀌어도 이 턴의 답변은
        // 고정된 기록 위에서 합성돼야 한다 (기준 95, §5.7 재현성)
        const pinned = await this.patientSnapshotService.readPayload(scope, pinnedSnapshotId);
        if (!pinned) throw new ServiceException('INTERNAL_ERROR');
        if (pinned.patientId !== row.id) {
          // 한 턴은 환자 한 명의 기록만 딛는다 — 다른 환자로 바꾸면 고정의 의미가 없어진다
          throw new ServiceException('BAD_REQUEST', { reason: 'AGENT_TURN_PATIENT_PINNED' });
        }
        return { outcome: 'RESOLVED', patient: toPatientDetailFromSnapshot(row, pinned) };
      }

      const captured = await this.patientSnapshotService.captureRow(scope, row);
      await this.repository.pinPatientSnapshot(assistantMessageId, captured.snapshotId);
      return { outcome: 'RESOLVED', patient: toPatientDetailFromSnapshot(row, captured.payload) };
    });
  }

  /**
   * 근거 도구 — 게이트 ③까지 흘리고 저장하지 않는다. 턴에 스냅샷이 있으면 그 진단명을 검색 입력에
   * 붙인다(복합 질문은 병명을 생략한다). 진단명은 에이전트가 아니라 BE가 턴에서 꺼낸다 — 에이전트가
   * 싣게 하면 검색 입력이 턴의 고정 기록과 어긋날 수 있다.
   */
  async streamGuidelineEvidence(
    principal: ClinicianPrincipal,
    assistantMessageId: string,
    dto: GuidelineEvidenceRequestDto,
    res: Response,
    clientSignal: AbortSignal,
  ): Promise<void> {
    const loaded = await this.openTurn(principal, assistantMessageId);

    let diagnoses: string[] = [];
    if (loaded.turn.patientSnapshotId) {
      const pinned = await this.patientSnapshotService.readPayload(
        { clinicId: principal.clinicId },
        loaded.turn.patientSnapshotId,
      );
      if (!pinned) throw new ServiceException('INTERNAL_ERROR');
      diagnoses = pinned.diagnoses;
    }

    await this.streamService.streamEvidence({
      query: dto.query,
      diagnoses,
      clientRequestId: this.requestIdOf(loaded),
      responseLang: langOf(loaded),
      res,
      clientSignal,
    });
  }

  /**
   * 완결 — 환자·복합·기타 경로의 턴을 닫는다.
   *
   * **닫힌 턴 판정이 본문 검증보다 먼저다** — 이미 끝난 턴에 온 요청은 내용과 무관하게 무의미하고,
   * 에이전트가 원인을 가를 수 있게 409로 답한다(기준 114). 종결은 조건부 UPDATE라 동시에 온 두 완결 중
   * 하나만 선다.
   */
  async finish(
    principal: ClinicianPrincipal,
    assistantMessageId: string,
    dto: FinishAgentTurnRequestDto,
  ): Promise<MessageResponseDto> {
    const loaded = await this.openTurn(principal, assistantMessageId);

    const answered = dto.status === 'COMPLETED';
    const abstained = dto.status === 'ABSTAINED';
    assertFinishShape(dto);

    const citations = answered ? (dto.citations ?? []) : [];
    const chunks = await this.conversationRepository.findEvidenceChunks([
      ...new Set(citations.map((citation) => citation.evidenceId)),
    ]);
    const contentById = new Map(chunks.map((chunk) => [chunk.id, chunk.content]));
    const missing: FieldError[] = citations.flatMap((citation, index) =>
      contentById.has(citation.evidenceId)
        ? []
        : [{ field: `citations.${index}.evidenceId`, constraints: ['존재하지 않는 근거입니다'] }],
    );
    if (missing.length > 0) throw new ServiceException('VALIDATION_FAILED', { errors: missing });

    await this.txManager.run(async () => {
      const closed = await this.conversationRepository.closeStreamingMessage(assistantMessageId, {
        status: dto.status,
        // 기권·실패는 답변 텍스트를 남기지 않는다 — 생성 게이트 기권과 같은 규칙이다 (§8 ④)
        content: answered ? (dto.content ?? '') : '',
        abstainReason: abstained ? (dto.abstainReason ?? null) : null,
      });
      if (!closed) throw new ServiceException('AGENT_TURN_CLOSED');

      await this.repository.recordRoute(assistantMessageId, {
        route: dto.route,
        classifierVersion: dto.classifierVersion,
      });

      await this.conversationRepository.insertCitations(
        citations.map((citation) => ({
          id: ulid(),
          messageId: assistantMessageId,
          evidenceChunkId: citation.evidenceId,
          marker: citation.marker,
          // 채팅과 같은 규칙의 발췌 — quote를 에이전트가 짓게 하면 원문과 어긋난 발췌가 인용이 된다
          quote: truncateQuote(contentById.get(citation.evidenceId) ?? ''),
        })),
      );

      if (dto.generation) {
        // LLM 호출마다 남긴다 — 기권도 토큰을 썼다 (§9, 「ABSTAINED + run = 생성 게이트」 불변식)
        await this.conversationRepository.insertGenerationRun({
          id: ulid(),
          messageId: assistantMessageId,
          provider: dto.generation.provider,
          model: dto.generation.model,
          promptVersion: dto.generation.promptVersion,
          originalQuestion: loaded.user.content,
          searchQuestion: dto.generation.searchQuestion ?? null,
          // NULL은 「검색하지 않은 생성」(환자 경로)이다 (기준 108)
          retrievalPolicyVersion: dto.generation.retrievalPolicyVersion ?? null,
          latencyMs: dto.generation.latencyMs,
          tokenUsage: {
            inputTokens: dto.generation.inputTokens,
            outputTokens: dto.generation.outputTokens,
          },
          traceId: this.traceContext.traceId,
        });
      }
    });

    return this.streamService.loadMessageDto(assistantMessageId, principal);
  }

  /** 수락한 턴만 — 그 밖의 메시지(채팅이 만든 답변 포함)는 404, 이미 닫힌 턴은 409 */
  private async openTurn(
    principal: ClinicianPrincipal,
    assistantMessageId: string,
  ): Promise<LoadedAgentTurn> {
    const loaded = await this.repository.findInScope(
      { clinicId: principal.clinicId },
      assistantMessageId,
    );
    if (!loaded) throw new ServiceException('NOT_FOUND');
    if (loaded.assistant.status !== 'STREAMING') throw new ServiceException('AGENT_TURN_CLOSED');
    return loaded;
  }

  /** SSE `requestId`의 원천 — 수락이 USER 메시지에 남긴 `clientRequestId`다 */
  private requestIdOf(loaded: LoadedAgentTurn): string {
    if (!loaded.user.clientRequestId) throw new ServiceException('INTERNAL_ERROR');
    return loaded.user.clientRequestId;
  }
}

/** 재조회와 같은 축 — 그 턴이 수락될 때의 언어다 (docs/specs/42 기준 11) */
function langOf(loaded: LoadedAgentTurn): SupportedLang {
  return (loaded.assistant.responseLang ?? 'ko') as SupportedLang;
}

/**
 * 상태별 본문 규칙 — DTO가 필드마다 보는 것을 넘어 **필드끼리의 모순**을 막는다.
 *
 * - `COMPLETED`는 답변 텍스트가 있어야 하고 기권 사유가 없어야 한다.
 * - `ABSTAINED`는 사유가 있어야 하고 답변 텍스트·인용이 없어야 한다 — 무관 근거를 인용한 산문 거부가
 *   영속화되던 §40 이전으로 돌아가지 않는다.
 * - `FAILED`·`CANCELLED`는 **검사하지 않는다.** 실패 경로의 완결이 422로 막히면 턴이 `STREAMING`으로
 *   남는다(§7이 `CANCELLED`를 둔 이유) — 실린 텍스트·인용·사유는 저장하지 않고 버린다(채팅이 실패한
 *   스트림의 델타를 남기지 않는 것과 같다).
 * - 인용 마커는 겹치지 않아야 한다 — 마커 하나가 두 근거를 가리키면 원문으로 되짚을 수 없다.
 */
function assertFinishShape(dto: FinishAgentTurnRequestDto): void {
  const errors: FieldError[] = [];
  const reject = (field: string, message: string): void => {
    errors.push({ field, constraints: [message] });
  };

  if (dto.status === 'COMPLETED') {
    if (dto.content === undefined) reject('content', 'COMPLETED에는 답변 텍스트가 필요합니다');
    if (dto.abstainReason !== undefined)
      reject('abstainReason', '기권이 아닌 완결에는 사유가 없습니다');
    const markers = (dto.citations ?? []).map((citation) => citation.marker);
    if (new Set(markers).size !== markers.length) reject('citations', '인용 마커가 겹칩니다');
  }
  if (dto.status === 'ABSTAINED') {
    if (dto.abstainReason === undefined) reject('abstainReason', 'ABSTAINED에는 사유가 필요합니다');
    if (dto.content) reject('content', '기권에는 답변 텍스트가 없습니다');
    if (dto.citations && dto.citations.length > 0) reject('citations', '기권에는 인용이 없습니다');
  }

  if (errors.length > 0) throw new ServiceException('VALIDATION_FAILED', { errors });
}
