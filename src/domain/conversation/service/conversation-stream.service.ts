import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ulid } from 'ulid';
import { monotonicUlid } from '../../../global/common/id/monotonic-ulid';
import { ErrorCodes } from '../../../global/common/exception/error-code.registry';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { TraceContext } from '../../../global/context/trace-context.service';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { LlmGateway } from '../../../infrastructure/llm/llm-gateway';
import { LlmEvidenceContext } from '../../../infrastructure/llm/llm-provider.port';
import {
  RETRIEVAL_POLICY_VERSION,
  RetrievalService,
  RetrievedEvidence,
} from '../../../infrastructure/retrieval/retrieval.service';
import { ClinicalGuidanceResponseDto } from '../../clinical-guidance/dto/response/clinical-guidance.response.dto';
import { ClinicalGuidanceComposer } from '../../clinical-guidance/service/clinical-guidance-composer.service';
import { toEvidenceDetail } from '../../guideline/mapper/guideline.mapper';
import {
  PatientSnapshotPayload,
  PatientSnapshotService,
} from '../../patient/service/patient-snapshot.service';
import { SendMessageRequestDto } from '../dto/request/send-message.request.dto';
import { toCitationDto, toMessageDto } from '../mapper/conversation.mapper';
import { MessageRow } from '../persistence/conversation.schema';
import { ConversationRepository } from '../repository/conversation.repository';
import { SseStream } from '../sse/sse-stream';

const PROMPT_VERSION = 'qa-v1';
const MODEL_LABEL = 'gateway-routed';
const QUOTE_LIMIT = 120;
const STREAM_TIMEOUT_MS = 120_000;
const PG_UNIQUE_VIOLATION = '23505';

/** PATIENT_GUIDANCE 스트림에서 완료 tx가 소비하는 가이던스 생성 재료 */
interface GuidanceContext {
  patientId: string;
  snapshotId: string;
  profile: PatientSnapshotPayload;
}

/**
 * SSE 스트리밍 오케스트레이터 (architecture.md §8 계약 전체).
 * message.accepted → retrieval.* → answer.delta(seq) → completed | abstained | error
 */
@Injectable()
export class ConversationStreamService {
  private readonly logger = new Logger(ConversationStreamService.name);

  constructor(
    private readonly repository: ConversationRepository,
    private readonly retrievalService: RetrievalService,
    private readonly llmGateway: LlmGateway,
    private readonly txManager: TransactionManager,
    private readonly traceContext: TraceContext,
    private readonly patientSnapshotService: PatientSnapshotService,
    private readonly guidanceComposer: ClinicalGuidanceComposer,
  ) {}

  async stream(
    principal: ClinicianPrincipal,
    conversationId: string,
    dto: SendMessageRequestDto,
    res: Response,
    clientSignal: AbortSignal,
  ): Promise<void> {
    // ── SSE 시작 전 검증 — 실패는 일반 봉투 오류로 나간다 ──
    const conversation = await this.repository.findById(
      { clinicianId: principal.clinicianId },
      conversationId,
    );
    if (!conversation) throw new ServiceException('NOT_FOUND');

    if (await this.repository.existsByClientRequestId(dto.clientRequestId)) {
      throw new ServiceException('DUPLICATE_CLIENT_REQUEST');
    }

    // 시간순 계약(id asc = 생성순, §5.7): 같은 ms 내 순서 보장을 위해 monotonic ULID 사용
    const userMessageId = monotonicUlid();
    const assistantMessageId = monotonicUlid();
    try {
      await this.txManager.run(async () => {
        await this.repository.insertMessage({
          id: userMessageId,
          conversationId,
          role: 'USER',
          content: dto.content,
          status: 'COMPLETED',
          answerKind: null,
          clientRequestId: dto.clientRequestId,
        });
        await this.repository.insertMessage({
          id: assistantMessageId,
          conversationId,
          role: 'ASSISTANT',
          content: '',
          status: 'STREAMING',
          answerKind:
            conversation.type === 'PATIENT_GUIDANCE' ? 'CLINICAL_GUIDANCE' : 'GUIDELINE_ANSWER',
          clientRequestId: null,
        });
      });
    } catch (error) {
      // 동시 요청 경합: unique 제약이 최종 방어선
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new ServiceException('DUPLICATE_CLIENT_REQUEST');
      }
      throw error;
    }

    // ── 이후는 SSE 계약 (§8) ──
    const sse = new SseStream(res);
    const traceId = this.traceContext.traceId;

    try {
      sse.send({
        eventType: 'message.accepted',
        requestId: dto.clientRequestId,
        userMessageId,
        assistantMessageId,
      });

      sse.send({ eventType: 'retrieval.started', requestId: dto.clientRequestId });
      const retrieved = await this.retrievalService.search(dto.content, dto.filters);
      sse.send({
        eventType: 'retrieval.completed',
        evidence: retrieved.map((row) => toEvidenceDetail(row)),
      });

      if (retrieved.length === 0) {
        await this.repository.updateMessage(assistantMessageId, {
          status: 'ABSTAINED',
          content: '',
        });
        const message = await this.loadMessageDto(assistantMessageId, principal);
        sse.send({
          eventType: 'answer.abstained',
          message,
          reason: '검색 조건에 해당하는 지침 근거를 찾지 못했습니다.',
          missingInformation: [],
        });
        return;
      }

      // PATIENT_GUIDANCE: 생성 직전 프로필을 immutable 스냅샷으로 고정하고 (§4.5, §9)
      // 복호화 프로필을 LLM 질문 컨텍스트에 합성한다. abstain 경로는 위에서 이미 이탈했다
      let guidanceContext: GuidanceContext | null = null;
      let question = dto.content;
      if (conversation.type === 'PATIENT_GUIDANCE') {
        if (!conversation.patientId) throw new ServiceException('INTERNAL_ERROR');
        const captured = await this.patientSnapshotService.captureWithProfile(
          { clinicId: principal.clinicId },
          conversation.patientId,
        );
        guidanceContext = {
          patientId: conversation.patientId,
          snapshotId: captured.snapshotId,
          profile: captured.payload,
        };
        question = composeGuidanceQuestion(captured.payload, dto.content);
      }

      await this.generateAnswer({
        sse,
        principal,
        retrieved,
        question,
        assistantMessageId,
        clientSignal,
        traceId,
        guidanceContext,
      });
    } catch (error) {
      await this.handleStreamFailure(error, assistantMessageId, clientSignal, sse, traceId);
    } finally {
      sse.end();
    }
  }

  private async generateAnswer(args: {
    sse: SseStream;
    principal: ClinicianPrincipal;
    retrieved: RetrievedEvidence[];
    question: string;
    assistantMessageId: string;
    clientSignal: AbortSignal;
    traceId: string;
    guidanceContext: GuidanceContext | null;
  }): Promise<void> {
    const { sse, retrieved, question, assistantMessageId, clientSignal, traceId } = args;

    const evidenceContext: LlmEvidenceContext[] = retrieved.map((row, index) => ({
      marker: index + 1,
      content: row.chunk.content,
      guidelineTitle: row.guideline.title,
      sectionPath: row.section.path,
    }));

    let seq = 0;
    const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(STREAM_TIMEOUT_MS)]);
    const outcome = await this.llmGateway.stream(
      { question, evidence: evidenceContext, signal },
      (delta) => {
        sse.send({ eventType: 'answer.delta', messageId: assistantMessageId, seq, delta });
        seq += 1;
      },
    );

    // 답변에 실제 등장한 마커만 인용으로 영속화
    const usedMarkers = new Set(
      [...outcome.text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])),
    );
    const citationRows = retrieved
      .map((row, index) => ({ row, marker: index + 1 }))
      .filter(({ marker }) => usedMarkers.has(marker))
      .map(({ row, marker }) => ({
        id: ulid(),
        messageId: assistantMessageId,
        evidenceChunkId: row.chunk.id,
        marker,
        quote: truncate(row.chunk.content, QUOTE_LIMIT),
      }));

    let guidance: ClinicalGuidanceResponseDto | null = null;
    await this.txManager.run(async () => {
      await this.repository.updateMessage(assistantMessageId, {
        content: outcome.text,
        status: 'COMPLETED',
      });
      await this.repository.insertCitations(citationRows);
      await this.repository.insertGenerationRun({
        id: ulid(),
        messageId: assistantMessageId,
        provider: outcome.provider,
        model: MODEL_LABEL,
        promptVersion: PROMPT_VERSION,
        retrievalPolicyVersion: RETRIEVAL_POLICY_VERSION,
        latencyMs: outcome.latencyMs,
        tokenUsage: {
          inputTokens: estimateTokens(question),
          outputTokens: estimateTokens(outcome.text),
        },
        traceId,
      });

      // 가이던스 행은 답변 영속화와 같은 tx에서 생성 — 부분 커밋으로 답변만 남는 상태를 막는다
      if (args.guidanceContext) {
        const citationDetails = await this.repository.listCitationDetails([assistantMessageId]);
        guidance = await this.guidanceComposer.compose({
          messageId: assistantMessageId,
          patientId: args.guidanceContext.patientId,
          patientSnapshotId: args.guidanceContext.snapshotId,
          clinicId: args.principal.clinicId,
          answerText: outcome.text,
          citations: citationDetails.map(toCitationDto),
          profile: args.guidanceContext.profile,
        });
      }
    });

    const message = await this.loadMessageDto(assistantMessageId, args.principal);
    // GUIDELINE_QA 완료 이벤트에는 guidance 속성 자체가 없어야 한다 (spec 10 기준 5)
    if (guidance) {
      sse.send({ eventType: 'answer.completed', message, guidance });
    } else {
      sse.send({ eventType: 'answer.completed', message });
    }
  }

  private async handleStreamFailure(
    error: unknown,
    assistantMessageId: string,
    clientSignal: AbortSignal,
    sse: SseStream,
    traceId: string,
  ): Promise<void> {
    if (clientSignal.aborted) {
      // §8-4: 클라이언트 abort → CANCELLED 정리 (이벤트는 보낼 수 없다)
      await this.repository.updateMessageIfStreaming(assistantMessageId, 'CANCELLED');
      return;
    }

    this.logger.error(`[${traceId}] 스트리밍 실패: ${String(error)}`);
    await this.repository.updateMessageIfStreaming(assistantMessageId, 'FAILED');
    sse.send({
      eventType: 'error',
      code: 'LLM_UNAVAILABLE',
      message: ErrorCodes.LLM_UNAVAILABLE.message,
      retryable: true,
      traceId,
    });
  }

  private async loadMessageDto(messageId: string, principal: ClinicianPrincipal) {
    const found = await this.repository.findMessageInScope(
      { clinicianId: principal.clinicianId },
      messageId,
    );
    if (!found) throw new ServiceException('INTERNAL_ERROR');
    const citations = await this.repository.listCitationDetails([messageId]);
    return toMessageDto(found.message as MessageRow, citations.map(toCitationDto));
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** 복호화 프로필을 질문 앞에 합성 — 프로필은 LLM 컨텍스트로만 쓰고 저장하지 않는다 (§4.5) */
function composeGuidanceQuestion(profile: PatientSnapshotPayload, question: string): string {
  const parts = [
    `진단: ${profile.diagnoses.join(', ') || '정보 없음'}`,
    `투약: ${profile.medications.join(', ') || '정보 없음'}`,
    `알레르기: ${profile.allergies.join(', ') || '없음'}`,
  ];
  if (profile.clinicalNotes) parts.push(`임상 메모: ${profile.clinicalNotes}`);
  return `[환자 프로필] ${parts.join(' / ')}\n${question}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
